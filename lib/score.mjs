// Turns judgments and checks into scores, ranges and tiers, by the rules in SCORING_LINES. Pure and deterministic.
import { CRITERION_IDS } from "./rubric.mjs";

const HOOK = ["H1", "H2", "H3", "H4", "H5"];
const GROUPS = [[0.35, ["H1", "H2", "H3", "H5"]], [0.3, ["H4", "S3", "S5"]], [0.2, ["S1", "S2", "S4"]], [0.15, ["S6", "S7", "S8"]]];
export const TRUTH_CAP = 40;
export const INDEX_WEIGHTS = { hooks: 20, script: 25 };

export const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN);
const defined = (values) => values.filter((v) => typeof v === "number" && Number.isFinite(v));
const clamp = (value) => Math.min(1, Math.max(0, value));
export const itemId = (key) => `${key.brief}|${key.contestant}|${key.sample}`;

/** A judge's grades count for a script only with both orderings answered, a truth grade, and at least 12 of the 14 criteria. */
export const MIN_CRITERIA = 12;

/** Each judge's criteria for each item, averaged over its two orderings; incomplete grades are left out and counted. */
function perJudge(judgments, requireComplete) {
  const grouped = new Map();
  for (const j of judgments) {
    const key = `${itemId(j)}#${j.judge}`;
    grouped.set(key, [...(grouped.get(key) ?? []), j]);
  }
  const out = new Map();
  let incomplete = 0;
  for (const [key, rows] of grouped) {
    const [item, judge] = key.split("#");
    // Each ordering must stand on its own: a truth grade and at least MIN_CRITERIA criteria.
    const complete = (row) => row.scores && row.scores.S9 !== undefined && Object.keys(row.scores).length >= MIN_CRITERIA;
    const usable = requireComplete ? rows.filter(complete) : rows;
    const perms = new Set(usable.map((row) => row.perm));
    if (requireComplete && !(perms.has(0) && perms.has(1))) {
      incomplete += 1;
      continue;
    }
    const scores = {};
    for (const id of CRITERION_IDS) {
      const value = mean(defined(usable.map((row) => row.scores?.[id])));
      if (Number.isFinite(value)) scores[id] = value;
    }
    if (!out.has(item)) out.set(item, new Map());
    out.get(item).set(judge, scores);
  }
  return { byItem: out, incomplete };
}

const hookShare = (s) => mean(defined(HOOK.map((id) => s[id]))) / 2;
const factsShare = (s) => mean(defined([s.S9])) / 2;
const visualShare = (s) => mean(defined([s.H5, s.S8])) / 2;
const scriptShare = (s) => {
  let total = 0;
  let weight = 0;
  for (const [w, ids] of GROUPS) {
    const value = mean(defined(ids.map((id) => s[id])));
    if (Number.isFinite(value)) { total += w * (value / 2); weight += w; }
  }
  return weight ? total / weight : NaN;
};

/** Additive per-judge strictness offsets, estimated on every item more than one judge graded; they sum to zero. */
export function severities(values, rounds = 60) {
  const judges = [...new Set([...values.values()].flatMap((byJudge) => [...byJudge.keys()]))];
  const sev = new Map(judges.map((judge) => [judge, 0]));
  for (let round = 0; round < rounds; round++) {
    const quality = new Map([...values].map(([item, byJudge]) => [item, mean([...byJudge].map(([judge, v]) => v - sev.get(judge)))]));
    for (const judge of judges) {
      const residuals = [...values].filter(([, byJudge]) => byJudge.has(judge) && byJudge.size > 1).map(([item, byJudge]) => byJudge.get(judge) - quality.get(item));
      sev.set(judge, residuals.length ? mean(residuals) : 0);
    }
    const centre = mean([...sev.values()]);
    for (const judge of judges) sev.set(judge, sev.get(judge) - centre);
  }
  return sev;
}

/**
 * Scores every item. `adjust` removes each judge's strictness; `keep(contestant, judge)` says which judges count toward an
 * item (the published view keeps judges from another vendor only); offsets are estimated from every judgment either way.
 */
export function scoreItems(items, judgments, options = {}) {
  const { byItem: all, incomplete } = perJudge(judgments, options.requireComplete !== false);
  const keep = options.keep;
  const graded = keep ? new Map([...all].map(([item, byJudge]) => [item, new Map([...byJudge].filter(([judge]) => keep(item.split("|")[1], judge)))])) : all;
  const view = (pick, source) => new Map([...source].map(([item, byJudge]) =>
    [item, new Map([...byJudge].map(([judge, s]) => [judge, pick(s)]).filter(([, v]) => Number.isFinite(v)))]));
  const none = new Map();
  const sevOf = (pick) => (options.adjust ? severities(view(pick, all)) : none);
  const sev = { hooks: sevOf(hookShare), script: sevOf(scriptShare), facts: sevOf(factsShare), visual: sevOf(visualShare) };
  const views = { hooks: view(hookShare, graded), script: view(scriptShare, graded), facts: view(factsShare, graded), visual: view(visualShare, graded) };
  const adjusted = (values, offsets) => mean([...(values ?? new Map())].map(([judge, v]) => v - (offsets.get(judge) ?? 0)));
  const scored = [];
  for (const item of items) {
    const id = itemId(item);
    const byJudge = graded.get(id);
    const unscored = { ...item, scored: false, hooks: null, script: null, index: null, facts: null, visualPlan: null, gated: false };
    if (!item.ok || (!item.checks && !item.plain) || !byJudge || !byJudge.size) {
      scored.push(unscored);
      continue;
    }
    // A plain reply comes in any layout, so it has no code checks and is scored on the judges alone.
    const c = item.checks;
    const judged = c ? 0.8 : 1;
    const coded = c ? 0.2 : 0;
    const det = c ? mean([c.D1, c.D2, c.D3, c.D4, c.D5]) / 2 : 0;
    const detHook = c ? mean([c.D2, c.D4h]) / 2 : 0;
    const h = clamp(adjusted(views.hooks.get(id), sev.hooks));
    const s = clamp(adjusted(views.script.get(id), sev.script));
    // The truth cap reads the truth grade after each judge's strictness is removed, which takes out a judge's average leniency.
    const truth = options.gate === "raw" ? mean(defined([...byJudge.values()].map((scores) => scores.S9))) / 2 : clamp(adjusted(views.facts.get(id), sev.facts));
    const gated = options.gate !== "none" && Number.isFinite(truth) && truth < 0.25;
    const hooks = 100 * (judged * h + coded * detHook);
    const script = Math.min(gated ? TRUTH_CAP : 100, 100 * (judged * s + coded * det));
    const index = (INDEX_WEIGHTS.hooks * hooks + INDEX_WEIGHTS.script * script) / (INDEX_WEIGHTS.hooks + INDEX_WEIGHTS.script);
    const facts = 100 * (judged * clamp(adjusted(views.facts.get(id), sev.facts)) + (c ? 0.2 * (c.D5 / 2) : 0));
    const visualPlan = 100 * (judged * clamp(adjusted(views.visual.get(id), sev.visual)) + (c ? 0.2 * (c.D4 / 2) : 0));
    if (!Number.isFinite(hooks) || !Number.isFinite(script)) {
      scored.push(unscored);
      continue;
    }
    const finite = (v) => (Number.isFinite(v) ? v : null);
    scored.push({ ...item, scored: true, hooks, script, index, facts: finite(facts), visualPlan: finite(visualPlan), gated });
  }
  return { items: scored, incomplete, severity: Object.fromEntries(Object.entries(sev).map(([k, m]) => [k, Object.fromEntries(m)])) };
}

/** Seeded randomness, so a rerun gives the same orders and ranges. */
export function rng(seed) {
  let a = typeof seed === "number" ? seed >>> 0 : [...String(seed)].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A copy of `list` in a seeded random order. */
export function shuffled(list, seed) {
  const random = rng(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Mean per contestant over briefs (a brief's samples averaged first), with a 95% bootstrap range over briefs. */
export function summarize(items, metric, resamples = 2000, seed = 20261018) {
  const usable = items.filter((item) => item.scored && Number.isFinite(item[metric]));
  const contestants = [...new Set(usable.map((item) => item.contestant))];
  return contestants.map((contestant) => {
    const byBrief = new Map();
    for (const item of usable.filter((row) => row.contestant === contestant)) byBrief.set(item.brief, [...(byBrief.get(item.brief) ?? []), item[metric]]);
    const perBrief = [...byBrief.values()].map(mean);
    const random = rng(seed);
    const draws = Array.from({ length: resamples }, () => mean(perBrief.map(() => perBrief[Math.floor(random() * perBrief.length)]))).sort((a, b) => a - b);
    return { contestant, metric, mean: mean(perBrief), low: draws[Math.floor(0.025 * resamples)], high: draws[Math.floor(0.975 * resamples) - 1], n: perBrief.length };
  });
}

/** Tiers: sorted by mean, a contestant whose range overlaps the current tier leader's joins that tier. */
export function tiers(summaries) {
  // Each tier's leader is the best model left; every model left whose range reaches the leader's low end joins it.
  let left = [...summaries].sort((a, b) => b.mean - a.mean);
  const out = [];
  let tier = 0;
  while (left.length) {
    tier += 1;
    const leader = left[0];
    const members = left.filter((row) => row === leader || row.high >= leader.low);
    for (const row of members) out.push({ ...row, tier });
    left = left.filter((row) => !members.includes(row));
  }
  return out;
}

/** Each model's difference from the leader on matched briefs (a brief's samples averaged first), with a 95% paired bootstrap. */
export function versusLeader(items, metric, leader, resamples = 2000, seed = 20261119) {
  const perBrief = (contestant) => {
    const byBrief = new Map();
    for (const item of items.filter((row) => row.scored && row.contestant === contestant && Number.isFinite(row[metric]))) byBrief.set(item.brief, [...(byBrief.get(item.brief) ?? []), item[metric]]);
    return new Map([...byBrief].map(([brief, values]) => [brief, mean(values)]));
  };
  const top = perBrief(leader);
  const contestants = [...new Set(items.filter((row) => row.scored).map((row) => row.contestant))].filter((c) => c !== leader);
  return contestants.map((contestant) => {
    const own = perBrief(contestant);
    const diffs = [...own].filter(([brief]) => top.has(brief)).map(([brief, value]) => value - top.get(brief));
    const random = rng(seed);
    const draws = Array.from({ length: resamples }, () => mean(diffs.map(() => diffs[Math.floor(random() * diffs.length)]))).sort((a, b) => a - b);
    return { contestant, leader, metric, diff: mean(diffs), low: draws[Math.floor(0.025 * resamples)], high: draws[Math.floor(0.975 * resamples) - 1], n: diffs.length };
  });
}
