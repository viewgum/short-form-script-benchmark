#!/usr/bin/env node
// The benchmark's command line: prompts, generate, judge-pack, judge, score. See the README for a full run.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { creatorPrompt, isPlain, readBriefs, WORDS_PER_MIN } from "../lib/prompt.mjs";
import { CRITERION_IDS, JUDGE_SYSTEM, judgeMessage, readJudgment } from "../lib/rubric.mjs";
import { APIS, call, costUsd, refusedBeforeWork, worstCaseUsd } from "../lib/providers.mjs";
import { checks, parseCreatorFormat, renderForJudge, scriptFields } from "../lib/shape.mjs";
import { scoreItems, shuffled, summarize, tiers } from "../lib/score.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_OUTPUT_TOKENS = 16000;
const JUDGE_MAX_TOKENS = 4000;
const NAME = "short-form-script-benchmark";

class UsageError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new UsageError(`unexpected argument "${arg}"`);
    const name = arg.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else { flags[name] = next; i++; }
  }
  return { command, flags };
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const readText = (file) => {
  try {
    return readFileSync(resolve(file), "utf8");
  } catch (error) {
    throw new UsageError(`cannot read ${file}: ${error.message}`);
  }
};
const readJson = (file) => {
  const text = readText(file);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${file} is not valid JSON: ${error.message}`);
  }
};
const need = (flags, name) => {
  if (typeof flags[name] !== "string") throw new UsageError(`--${name} is required`);
  return flags[name];
};
const dirs = (path) => (existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : []);

function loadModels(flags) {
  const doc = readJson(flags.models ?? join(ROOT, "models.json"));
  return { contestants: doc.contestants ?? [], judges: doc.judges ?? [] };
}
const findModel = (models, id) => [...models.judges, ...models.contestants].find((m) => m.id === id);

function pickContestants(flags, models) {
  const wanted = need(flags, "contestants");
  if (wanted === "all") return models.contestants;
  return wanted.split(",").map((id) => {
    const model = models.contestants.find((m) => m.id === id);
    if (!model) throw new UsageError(`unknown contestant "${id}" (see models.json)`);
    return model;
  });
}

const sampleCount = (flags) => {
  const n = Number(flags.samples ?? 2);
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new UsageError("--samples must be a whole number from 1 to 10");
  return n;
};

function ratesFor(flags, ids) {
  const file = need(flags, "rates");
  const rates = readJson(file);
  for (const id of ids) {
    const r = rates[id];
    if (!r || !Number.isFinite(r.input) || !Number.isFinite(r.output) || r.input <= 0 || r.output <= 0) {
      throw new UsageError(`${file}: ${id} needs input and output rates above zero (USD per million tokens, from its maker's price page)`);
    }
  }
  return rates;
}

const maxUsdOf = (flags) => {
  const value = Number(need(flags, "max-usd"));
  if (!Number.isFinite(value) || value <= 0) throw new UsageError("--max-usd must be a positive number");
  return value;
};

function needKeys(models) {
  for (const api of new Set(models.map((m) => m.api))) {
    const keyEnv = APIS[api]?.keyEnv;
    if (!keyEnv) throw new UsageError(`unknown api "${api}" in models.json`);
    if (!process.env[keyEnv]) throw new UsageError(`set ${keyEnv} to run ${models.filter((m) => m.api === api).map((m) => m.id).join(", ")}`);
  }
}

/** One process at a time per run folder, so two runs never spend against the same ledger at once. */
function lockRun(runDir) {
  mkdirSync(runDir, { recursive: true });
  const file = join(runDir, ".lock");
  try {
    writeFileSync(file, String(process.pid), { flag: "wx" });
  } catch {
    throw new UsageError(`${runDir} is in use by another run (process ${readText(file).trim()}); delete ${file} if that run has ended`);
  }
  const release = () => rmSync(file, { force: true });
  process.once("exit", release);
  return release;
}

/**
 * The dollar ledger in the run folder. Every call is written as pending, at its worst case, before it is sent, and settled
 * after; a pending call that never settled (the process was stopped) keeps counting at its worst case. A resumed run counts
 * everything already in the file.
 */
function budget(runDir, maxUsd) {
  const file = join(runDir, "ledger.jsonl");
  const rows = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const settledIds = new Set(rows.filter((r) => r.id && r.kind !== "pending").map((r) => r.id));
  let spent = rows.reduce((sum, r) => sum + (r.kind === "pending" ? (settledIds.has(r.id) ? 0 : r.worst ?? 0) : r.usd ?? 0), 0);
  let reserved = 0;
  const write = (row) => appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
  return {
    spent: () => spent,
    /** Writes the call as pending at its worst case and returns settle(row), or null when the call could pass the cap. */
    reserve: (worst, what) => {
      if (spent + reserved + worst > maxUsd) return null;
      const id = randomUUID();
      write({ kind: "pending", id, worst, ...what });
      reserved += worst;
      let open = true;
      return (row) => {
        if (!open) return;
        open = false;
        reserved -= worst;
        spent += row.usd;
        write({ kind: "settled", id, ...what, ...row });
      };
    },
  };
}

/** The settings a run started with; a resume that changes them would mix two experiments, so it is refused. */
function checkManifest(runDir, briefsText, briefs, contestants) {
  const file = join(runDir, "manifest.json");
  const now = {
    briefsSha256: sha256(briefsText),
    promptsSha256: sha256(briefs.map(creatorPrompt).join("\n\n")),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    contestants: Object.fromEntries(contestants.map((m) => [m.id, { api: m.api, model: m.model }])),
  };
  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify({ created: new Date().toISOString(), ...now }, null, 2)}\n`);
    return;
  }
  const before = JSON.parse(readFileSync(file, "utf8"));
  for (const key of ["briefsSha256", "promptsSha256", "maxOutputTokens"]) {
    if (before[key] !== now[key]) throw new UsageError(`${runDir} was started with a different ${key}; use a new --run folder`);
  }
  for (const [id, spec] of Object.entries(now.contestants)) {
    const was = before.contestants?.[id];
    if (was && (was.api !== spec.api || was.model !== spec.model)) throw new UsageError(`${runDir} ran ${id} as ${was.model}; use a new --run folder`);
  }
  before.contestants = { ...before.contestants, ...now.contestants };
  writeFileSync(file, `${JSON.stringify(before, null, 2)}\n`);
}

const outputFile = (runDir, model, brief, sample) => join(runDir, "outputs", model, `${brief}-${sample}.txt`);

/** Settles a failed call: nothing when the vendor refused it before any work, its worst case otherwise, since it may have been billed. */
function settleFailure(settle, error, worst) {
  const refused = refusedBeforeWork(error);
  settle({ usage: { input: 0, output: 0 }, usd: refused ? 0 : worst, ok: false, uncertain: !refused, note: String(error.message).slice(0, 300) });
  return refused && [401, 403, 404].includes(error.status);
}

/** A reply's cost; a reply that reports no usage counts at its worst case. */
const usdOf = (rates, result, worst) => (result.usage.input > 0 || result.usage.output > 0 ? costUsd(rates, result.usage) : worst);

async function generate(flags) {
  const briefsFile = need(flags, "briefs");
  const briefsText = readText(briefsFile);
  const briefs = readBriefs(JSON.parse(briefsText));
  const contestants = pickContestants(flags, loadModels(flags));
  const runDir = resolve(need(flags, "run"));
  const samples = sampleCount(flags);
  const rates = ratesFor(flags, contestants.map((m) => m.id));
  const cap = maxUsdOf(flags);
  needKeys(contestants);
  const release = lockRun(runDir);
  try {
    checkManifest(runDir, briefsText, briefs, contestants);
    const money = budget(runDir, cap);
    const concurrency = Number(flags.concurrency ?? 1);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new UsageError("--concurrency must be a whole number from 1 to 16");
    let made = 0;
    let failed = 0;
    let stop = 0;
    const one = async (model, brief, sample) => {
      const file = outputFile(runDir, model.id, brief.id, sample);
      if (existsSync(file) && (isPlain(brief) ? readFileSync(file, "utf8").trim() : parseCreatorFormat(readFileSync(file, "utf8")))) return;
      const prompt = creatorPrompt(brief);
      const worst = worstCaseUsd(rates[model.id], Buffer.byteLength(prompt), MAX_OUTPUT_TOKENS);
      const settle = money.reserve(worst, { role: "contestant", who: model.id, brief: brief.id, sample });
      if (!settle) {
        if (!stop) console.log(`stopped before ${model.id} ${brief.id} #${sample}: $${money.spent().toFixed(2)} counted, and this call could pass the $${cap} cap`);
        stop = stop || 3;
        return;
      }
      try {
        const result = await call(model, { prompt, maxTokens: MAX_OUTPUT_TOKENS });
        const usd = usdOf(rates[model.id], result, worst);
        const ok = Boolean(result.text.trim());
        settle({ usage: result.usage, usd, ms: result.ms, stop: result.stop, ok, ...(ok ? {} : { note: "empty reply" }) });
        if (!ok) {
          failed += 1;
          console.log(`${model.id} ${brief.id} #${sample}: empty reply (stop ${result.stop || "unknown"}); rerun to retry`);
          return;
        }
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(`${file}.part`, result.text);
        renameSync(`${file}.part`, file);
        made += 1;
        if (!isPlain(brief) && !parseCreatorFormat(result.text)) console.log(`${model.id} ${brief.id} #${sample}: reply kept, but not in the prompt's format (scored as unparsed)`);
        console.log(`${model.id} ${brief.id} #${sample}: ${result.usage.output} output tokens, $${usd.toFixed(4)}, ${(result.ms / 1000).toFixed(1)} s`);
      } catch (error) {
        failed += 1;
        const fatal = settleFailure(settle, error, worst);
        console.log(`${model.id} ${brief.id} #${sample}: failed (${error.message})`);
        if (fatal) {
          console.log(`stopping ${model.id}: refused (HTTP ${error.status}); check its key and model id`);
          throw error;
        }
      }
    };
    // Each contestant's calls run in order; up to --concurrency contestants run at once.
    const queue = [...contestants];
    const worker = async () => {
      for (let model = queue.shift(); model; model = queue.shift()) {
        try {
          for (const brief of briefs) for (let sample = 1; sample <= samples; sample++) {
            if (stop) return;
            await one(model, brief, sample);
          }
        } catch {
          stop = stop || 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, contestants.length) }, worker));
    if (stop) return stop;
    console.log(`done: ${made} new scripts, ${failed} failed, $${money.spent().toFixed(2)} counted in ${runDir}`);
    return failed ? 1 : 0;
  } finally {
    release();
  }
}

/** Every reply in a run folder, read into the plain layout: { contestant, brief, sample, script } (script null if unreadable). */
function readOutputs(runDir) {
  const root = join(runDir, "outputs");
  if (!existsSync(root)) throw new UsageError(`${root} does not exist`);
  const out = [];
  for (const contestant of dirs(root)) {
    for (const name of readdirSync(join(root, contestant)).sort()) {
      const match = /^(.+)-(\d+)\.txt$/.exec(name);
      if (!match) continue;
      const raw = readFileSync(join(root, contestant, name), "utf8");
      out.push({ contestant, brief: match[1], sample: Number(match[2]), raw, script: parseCreatorFormat(raw) });
    }
  }
  return out;
}

/** Judge packs use opaque names; the key that maps them back to a script lives outside the pack. */
const packName = () => randomUUID().replace(/-/g, "").slice(0, 16);

/** The judge prompt for one reply and ordering, rebuilt the same way every time, so a published run needs no prompt files. */
function judgePrompt(brief, item, judge, perm) {
  const shown = brief && isPlain(brief) ? item.raw.trim() : item.script ? renderForJudge(item.script) : "";
  if (!brief || !shown) return null;
  const order = shuffled(CRITERION_IDS, `${item.brief}|${item.contestant}|${item.sample}|${judge}|${perm}`);
  return `${JUDGE_SYSTEM}\n\n${judgeMessage(brief, shown, order, perm)}\n`;
}
const keyFile = (runDir, judge) => join(runDir, "judging-keys", `${judge}.json`);

function judgePack(flags) {
  const briefs = new Map(readBriefs(readJson(need(flags, "briefs"))).map((b) => [b.id, b]));
  const runDir = resolve(need(flags, "run"));
  const judge = need(flags, "judge");
  const models = loadModels(flags);
  const judgeMaker = findModel(models, judge)?.maker;
  if (!judgeMaker) throw new UsageError(`judge "${judge}" is not in models.json with a maker`);
  // A judge grades only other makers' scripts unless --all-makers asks for its own maker's too (for its strictness and the alternative views).
  const keep = (contestant) => flags["all-makers"] === true || findModel(models, contestant)?.maker !== judgeMaker;
  const dir = join(runDir, "judging", judge);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(runDir, "judging-keys"), { recursive: true });
  const keys = existsSync(keyFile(runDir, judge)) ? JSON.parse(readFileSync(keyFile(runDir, judge), "utf8")) : {};
  let written = 0;
  for (const item of readOutputs(runDir)) {
    const brief = briefs.get(item.brief);
    if (!brief || !judgePrompt(brief, item, judge, 0)) continue;
    if (!keep(item.contestant)) continue;
    for (const perm of [0, 1]) {
      const text = judgePrompt(brief, item, judge, perm);
      const known = Object.entries(keys).find(([, k]) => k.contestant === item.contestant && k.brief === item.brief && k.sample === item.sample && k.perm === perm);
      const name = known ? known[0] : packName();
      if (known && known[1].promptSha256 !== sha256(text)) throw new UsageError(`the script or rubric behind ${name} changed since it was packed; use a new --run folder`);
      keys[name] = { contestant: item.contestant, brief: item.brief, sample: item.sample, perm, promptSha256: sha256(text) };
      const file = join(dir, `${name}.prompt.txt`);
      if (existsSync(file)) continue;
      writeFileSync(file, text);
      written += 1;
    }
  }
  writeFileSync(keyFile(runDir, judge), `${JSON.stringify(keys, null, 2)}\n`);
  console.log(`${written} judge prompts in ${dir}; save each answer as the same name ending .reply.txt`);
  return 0;
}

async function judgeApi(flags) {
  const runDir = resolve(need(flags, "run"));
  const judgeId = need(flags, "judge");
  const model = findModel(loadModels(flags), judgeId);
  if (!model?.api) throw new UsageError(`"${judgeId}" is not a judge or contestant with an api in models.json`);
  const rates = ratesFor(flags, [judgeId]);
  const cap = maxUsdOf(flags);
  const dir = join(runDir, "judging", judgeId);
  if (!existsSync(dir)) throw new UsageError(`run judge-pack --judge ${judgeId} first`);
  needKeys([model]);
  const release = lockRun(runDir);
  try {
    const money = budget(runDir, cap);
    let failed = 0;
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".prompt.txt")).sort()) {
      const replyFile = join(dir, name.replace(/\.prompt\.txt$/, ".reply.txt"));
      if (existsSync(replyFile) && /\{[\s\S]*"scores"[\s\S]*\}/.test(readFileSync(replyFile, "utf8"))) continue;
      const text = readFileSync(join(dir, name), "utf8");
      const message = text.slice(JUDGE_SYSTEM.length).trim();
      const worst = worstCaseUsd(rates[judgeId], Buffer.byteLength(text), JUDGE_MAX_TOKENS);
      const settle = money.reserve(worst, { role: "judge", who: judgeId, file: name });
      if (!settle) {
        console.log(`stopped: $${money.spent().toFixed(2)} counted, and the next judge call could pass the $${cap} cap`);
        return 3;
      }
      try {
        const result = await call(model, { prompt: message, system: JUDGE_SYSTEM, maxTokens: JUDGE_MAX_TOKENS, judge: true });
        const ok = Boolean(result.text.trim());
        settle({ usage: result.usage, usd: usdOf(rates[judgeId], result, worst), ms: result.ms, ok });
        if (ok) {
          writeFileSync(`${replyFile}.part`, result.text);
          renameSync(`${replyFile}.part`, replyFile);
        } else failed += 1;
      } catch (error) {
        failed += 1;
        const fatal = settleFailure(settle, error, worst);
        console.log(`${name}: failed (${error.message})`);
        if (fatal) return 1;
      }
    }
    console.log(`judging by ${judgeId}: ${failed} failed, $${money.spent().toFixed(2)} counted in ${runDir}`);
    return failed ? 1 : 0;
  } finally {
    release();
  }
}

const round1 = (v) => (Number.isFinite(v) ? Number(`${Math.round(Number(`${v}e1`))}e-1`).toFixed(1) : "-");

function score(flags) {
  const briefList = readBriefs(readJson(need(flags, "briefs")));
  const briefs = new Map(briefList.map((b) => [b.id, b]));
  const runDir = resolve(need(flags, "run"));
  const models = loadModels(flags);
  const outputs = readOutputs(runDir);
  const items = outputs.map((o) => {
    const brief = briefs.get(o.brief);
    if (brief && isPlain(brief)) return { brief: o.brief, contestant: o.contestant, sample: o.sample, ok: Boolean(o.raw.trim()), plain: true, checks: null, parsed: { raw: o.raw.trim() } };
    return { brief: o.brief, contestant: o.contestant, sample: o.sample, ok: Boolean(o.script && brief), checks: o.script && brief ? checks(o.script, brief) : undefined, parsed: o.script };
  });
  const byKey = new Map(items.map((i) => [`${i.contestant}|${i.brief}|${i.sample}`, i]));
  const rawOf = new Map(outputs.map((o) => [`${o.contestant}|${o.brief}|${o.sample}`, o]));
  const judgments = [];
  let dropped = 0;
  let unreadable = 0;
  for (const judge of dirs(join(runDir, "judging"))) {
    if (!findModel(models, judge)?.maker) throw new UsageError(`judge "${judge}" has no maker in models.json`);
    const keys = existsSync(keyFile(runDir, judge)) ? JSON.parse(readFileSync(keyFile(runDir, judge), "utf8")) : {};
    for (const [name, key] of Object.entries(keys)) {
      const file = join(runDir, "judging", judge, `${name}.reply.txt`);
      const item = byKey.get(`${key.contestant}|${key.brief}|${key.sample}`);
      if (!existsSync(file) || !item?.ok) continue;
      // The reply must answer the prompt its key names: rebuilt from the reply it graded, and the prompt file when one is kept.
      const promptFile = join(runDir, "judging", judge, `${name}.prompt.txt`);
      const rebuilt = judgePrompt(briefs.get(key.brief), rawOf.get(`${key.contestant}|${key.brief}|${key.sample}`), judge, key.perm);
      const stale = key.promptSha256 && (sha256(rebuilt ?? "") !== key.promptSha256 || (existsSync(promptFile) && sha256(readFileSync(promptFile, "utf8")) !== key.promptSha256));
      if (stale) throw new UsageError(`${name} for ${judge} does not match its key; the reply or the pack changed after it was answered`);
      const read = readJudgment(readFileSync(file, "utf8"), item.plain ? [item.parsed.raw] : scriptFields(item.parsed));
      if (!read) { unreadable += 1; continue; }
      dropped += read.dropped;
      judgments.push({ brief: item.brief, contestant: item.contestant, sample: item.sample, judge, perm: key.perm, scores: read.scores });
    }
  }
  const keep = (contestant, judge) => {
    const a = findModel(models, contestant)?.maker;
    const b = findModel(models, judge)?.maker;
    return Boolean(a && b && a !== b);
  };
  const { items: scored, severity, incomplete } = scoreItems(items, judgments, { adjust: true, keep });
  const metrics = ["index", "hooks", "script", "facts", "visualPlan"];
  const summary = Object.fromEntries(metrics.map((metric) => [metric, summarize(scored, metric)]));
  const ranked = tiers(summary.index);
  const contestantIds = [...new Set(items.map((i) => i.contestant))];
  const samplesSeen = Math.max(0, ...items.map((i) => i.sample));
  const coverage = contestantIds.map((id) => ({
    contestant: id,
    expected: briefList.length * samplesSeen,
    scripts: items.filter((i) => i.contestant === id).length,
    unparsed: items.filter((i) => i.contestant === id && !i.ok).length,
    scored: scored.filter((i) => i.contestant === id && i.scored).length,
  }));
  const results = {
    schema: 2,
    run: basename(runDir),
    scoredAt: new Date().toISOString().slice(0, 10),
    method: { wordsPerMinute: WORDS_PER_MIN, maxOutputTokens: MAX_OUTPUT_TOKENS, quoteRule: "whole words in order, from the script's own fields" },
    contestants: contestantIds.map((id) => {
      const m = findModel(models, id);
      return { id, name: m?.name ?? id, maker: m?.maker ?? null, model: m?.model ?? null };
    }),
    judges: [...new Set(judgments.map((j) => j.judge))].map((id) => ({ id, name: findModel(models, id)?.name ?? id, maker: findModel(models, id)?.maker ?? null })),
    briefs: briefList.map(({ id, platform, targetSec, niche, audience, topic, ask }) => (ask ? { id, platform, targetSec, ask } : { id, platform, targetSec, niche, audience, topic })),
    counts: { scripts: items.length, unparsed: items.filter((i) => !i.ok).length, judgments: judgments.length, unreadableReplies: unreadable, droppedQuotes: dropped, incompleteGrades: incomplete },
    coverage,
    severity,
    summary,
    tiers: ranked,
    items: scored.map(({ parsed, ...rest }) => rest),
    outputs: items.filter((i) => i.ok).map((i) => ({ brief: i.brief, contestant: i.contestant, sample: i.sample, script: i.parsed })),
  };
  writeFileSync(join(runDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  const row = (metric, id) => {
    const s = summary[metric].find((x) => x.contestant === id);
    return s ? `${round1(s.mean)} (${round1(s.low)} to ${round1(s.high)})` : "not scored";
  };
  console.log("| Tier | Contestant | Index | Hooks | Script | Facts | Visual plan |");
  console.log("|---|---|---|---|---|---|---|");
  for (const t of ranked) console.log(`| ${t.tier} | ${findModel(models, t.contestant)?.name ?? t.contestant} | ${row("index", t.contestant)} | ${row("hooks", t.contestant)} | ${row("script", t.contestant)} | ${row("facts", t.contestant)} | ${row("visualPlan", t.contestant)} |`);
  for (const c of coverage.filter((c) => c.scored < c.expected)) console.log(`${c.contestant}: ${c.scored} of ${c.expected} expected scripts scored (${c.scripts} written, ${c.unparsed} unparsed)`);
  const n = results.counts;
  console.log(`\n${n.scripts} scripts (${n.unparsed} unparsed), ${n.judgments} judgments, ${n.unreadableReplies} unreadable replies, ${n.incompleteGrades} incomplete grades left out, ${n.droppedQuotes} scores dropped for a quote not in the script. Written to ${join(runDir, "results.json")}`);
  return 0;
}

function prompts(flags) {
  const briefs = readBriefs(readJson(need(flags, "briefs")));
  const only = typeof flags.brief === "string" ? flags.brief : null;
  const picked = only ? briefs.filter((b) => b.id === only) : briefs;
  if (!picked.length) throw new UsageError(`no brief "${only}"`);
  for (const brief of picked) console.log(`----- ${brief.id}\n${creatorPrompt(brief)}\n`);
  return 0;
}

const HELP = `Usage: ${NAME} <command> [flags]   (or: node bin/bench.mjs <command> [flags])

  prompts     --briefs FILE [--brief ID]                 print the prompt each contestant gets
  generate    --briefs FILE --contestants IDS|all --run DIR --rates FILE --max-usd N [--samples 2] [--concurrency 1] [--models FILE]
  judge-pack  --briefs FILE --run DIR --judge ID [--all-makers]   two judge prompts per script of another maker, for any model or CLI
  judge       --run DIR --judge ID --rates FILE --max-usd N [--models FILE]   answer a pack through the judge's API
  score       --briefs FILE --run DIR [--models FILE]     checks, judges from other makers only, ranges and tiers

Keys come from ANTHROPIC_API_KEY, OPENAI_API_KEY and GEMINI_API_KEY. Rates are yours: USD per million tokens per model id.
Exit codes: 0 done, 1 some calls failed, 2 bad input, 3 stopped at the spending cap.`;

export async function main(argv) {
  try {
    const { command, flags } = parseArgs(argv);
    if (command === "help" || command === "--help" || command === "-h" || flags.help) { console.log(HELP); return 0; }
    if (!command) { console.log(HELP); return 2; }
    if (command === "prompts") return prompts(flags);
    if (command === "generate") return await generate(flags);
    if (command === "judge-pack") return judgePack(flags);
    if (command === "judge") return await judgeApi(flags);
    if (command === "score") return score(flags);
    throw new UsageError(`unknown command "${command}"`);
  } catch (error) {
    if (error instanceof UsageError) { console.error(`${NAME}: ${error.message}`); return 2; }
    throw error;
  }
}

const invoked = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
