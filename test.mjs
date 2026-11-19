// Tests: node test.mjs. No network, no keys, no dependencies.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { creatorPrompt, PLATFORM_NAMES, readBriefs, targetWords } from "./lib/prompt.mjs";
import { CHECK_RULES, CRITERIA, CRITERION_IDS, JUDGE_SYSTEM, judgeMessage, quoted, readJudgment, SCORING_LINES } from "./lib/rubric.mjs";
import { checks, parseCreatorFormat, renderForJudge, scriptFields, unsourcedNumbers } from "./lib/shape.mjs";
import { rng, scoreItems, severities, shuffled, summarize, tiers, versusLeader } from "./lib/score.mjs";
import { render } from "./scripts/render-scripts.mjs";
import { HttpError, refusedBeforeWork, request, worstCaseUsd } from "./lib/providers.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const BENCH = join(ROOT, "bin", "bench.mjs");
const published = JSON.parse(readFileSync(join(ROOT, "method/published-method.json"), "utf8"));
const briefDoc = JSON.parse(readFileSync(join(ROOT, "briefs/pilot-2026-10-18.json"), "utf8"));
const briefs = readBriefs(briefDoc);
const byId = new Map(briefs.map((b) => [b.id, b]));

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

test("the prompt is the published one, filled from each brief", () => {
  for (const brief of briefs) {
    const filled = published.directPrompt
      .replace("{platform}", PLATFORM_NAMES[brief.platform]).replace("{creator}", brief.brand.name).replace("{niche}", brief.brand.niche)
      .replace("{kind}", brief.brand.kind).replace("{voice}", brief.brand.voice).replace("{audience}", brief.audience)
      .replace("{topic}", brief.topic).replace("{seconds}", String(brief.targetSec)).replace("{words}", String(targetWords(brief)));
    assert.equal(creatorPrompt(brief), filled, brief.id);
  }
});

test("the rubric, checks and scoring lines are the published ones with the listed amendments", () => {
  const { amendments } = JSON.parse(readFileSync(join(ROOT, "method/amendments.json"), "utf8"));
  const criteria = structuredClone(published.criteria);
  const scoring = [...published.scoring];
  for (const change of amendments) {
    for (const [id, criterion] of Object.entries(change.criteria ?? {})) criteria[criteria.findIndex((c) => c.id === id)] = criterion;
    for (const [index, line] of Object.entries(change.scoring ?? {})) scoring[Number(index)] = line;
  }
  assert.deepEqual(CRITERIA, criteria);
  assert.deepEqual(CHECK_RULES, published.checks);
  assert.deepEqual(SCORING_LINES, scoring);
  assert.equal(published.wordsPerMinute, 165);
});

test("the briefs file matches the published briefs field for field", () => {
  assert.equal(briefs.length, published.briefs.length);
  for (const given of published.briefs) {
    const local = byId.get(given.id);
    for (const key of ["platform", "targetSec", "niche", "audience", "topic"]) assert.equal(local[key], given[key], `${given.id}.${key}`);
  }
});

test("readBriefs refuses broken briefs", () => {
  assert.throws(() => readBriefs({ briefs: [] }), /non-empty/);
  assert.throws(() => readBriefs([{ ...briefs[0], platform: "vine" }]), /platform/);
  assert.throws(() => readBriefs([briefs[0], briefs[0]]), /repeated/);
  assert.throws(() => readBriefs([{ ...briefs[0], brand: { ...briefs[0].brand, voice: "" } }]), /brand.voice/);
});

const RAW = `**HOOK:** You're not bad at saving. You're saving last.
HOOK TEXT: You're saving last.
HOOK VISUAL: A phone showing a $0.00 balance.
LINES:
1. SAY: Paycheck lands, bills go out, and savings get what's left. | TEXT: Bills, then you | VISUAL: Cash moving through boxes
2. SAY: Flip the order. | TEXT: none | VISUAL: The savings box jumps to the front
3. **SAY:** Set a transfer for payday morning. | TEXT: Auto-transfer on payday | VISUAL: A banking app's recurring transfer screen
CLOSE: Willpower doesn't get a vote.
ALT HOOKS:
- Saving last is why it never works.
- 1. Your savings order is backwards.`;

test("parseCreatorFormat reads the prompt's format, bold labels and none", () => {
  const s = parseCreatorFormat(RAW);
  assert.equal(s.hook, "You're not bad at saving. You're saving last.");
  assert.equal(s.hookText, "You're saving last.");
  assert.equal(s.lines.length, 3);
  assert.equal(s.lines[1].text, undefined);
  assert.equal(s.lines[2].say, "Set a transfer for payday morning.");
  assert.equal(s.close, "Willpower doesn't get a vote.");
  assert.deepEqual(s.altHooks, ["Saving last is why it never works.", "Your savings order is backwards."]);
  assert.equal(parseCreatorFormat("Sure! Here is a great script about saving."), null);
  assert.equal(parseCreatorFormat("SAY: only one line"), null);
  const tricky = parseCreatorFormat("HOOK: Look.\nLINES:\n1. SAY: Read the text: it matters | TEXT: Two words | VISUAL: a shot\n2. SAY: Next. | VISUAL: b");
  assert.deepEqual(tricky.lines[0], { say: "Read the text: it matters", text: "Two words", visual: "a shot" });
});

test("renderForJudge uses the same labels for everyone and leaves out alternative hooks", () => {
  const text = renderForJudge(parseCreatorFormat(RAW));
  assert.match(text, /^HOOK \(spoken\): /);
  assert.match(text, /2\. SAY: Flip the order\. \| ON SCREEN: none \| VISUAL: /);
  assert.doesNotMatch(text, /backwards/);
});

const script = (hook, says, extra = {}) => ({ hook, hookText: "Save first", lines: says.map((say) => ({ say, text: "Short text" })), altHooks: [], ...extra });

test("D1 length: within 15% is 2, within 30% is 1", () => {
  const brief = byId.get("P02");
  assert.equal(targetWords(brief), 83);
  const nWords = (n) => Array.from({ length: n }, () => "word").join(" ");
  assert.equal(checks(script("Salt less.", [nWords(81 - 2)]), brief).D1, 2);
  assert.equal(checks(script("Salt less.", [nWords(83 + 12 - 2)]), brief).D1, 2);
  assert.equal(checks(script("Salt less.", [nWords(83 + 13 - 2)]), brief).D1, 1);
  assert.equal(checks(script("Salt less.", [nWords(83 + 25 - 2)]), brief).D1, 0);
});

test("D2 fast start: a greeting is 0, a long first sentence loses points", () => {
  const brief = byId.get("P02");
  assert.equal(checks(script("Hey guys, pasta water time.", ["One line."]), brief).D2, 0);
  assert.equal(checks(script("So here is the thing.", ["One line."]), brief).D2, 0);
  assert.equal(checks(script("Your pasta water is far too salty.", ["One line."]), brief).D2, 2);
  const eighteen = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen.";
  assert.equal(checks(script(eighteen, ["One line."]), brief).D2, 1);
});

test("D4 and D4h: on-screen text length", () => {
  const brief = byId.get("P02");
  assert.equal(checks(script("Salt less.", ["One."]), brief).D4h, 2);
  assert.equal(checks(script("Salt less.", ["One."], { hookText: undefined }), brief).D4, 0);
  assert.equal(checks(script("Salt less.", ["One."], { hookText: "one two three four five six seven eight nine" }), brief).D4h, 1);
});

test("D5 counts money, percents and numbers over ten that the brief did not give", () => {
  const brief = byId.get("P04");
  assert.deepEqual(unsourcedNumbers("It takes 36 hours, and 3 folds.", brief), []);
  assert.deepEqual(unsourcedNumbers("Bread sales rose 40% and cost $12.", brief), ["40%", "$12."]);
  assert.deepEqual(unsourcedNumbers("Our 3rd and 21st loaves.", brief), []);
  assert.deepEqual(unsourcedNumbers("Not $36, not 36%, just 36.", brief), ["$36,", "36%"]);
  assert.equal(checks(script("Why 36 hours?", ["It costs $5 and saves 20%."]), brief).D5, 0);
  assert.equal(checks(script("Why 36 hours?", ["It costs $5."]), brief).D5, 1);
});

test("quotes must be whole words, in order, from the script's own fields", () => {
  const fields = scriptFields(parseCreatorFormat(RAW));
  assert.ok(quoted("you're NOT bad at saving", fields));
  assert.ok(quoted("Paycheck lands... savings get what's left", fields));
  assert.ok(!quoted("savings get what's left... Paycheck lands", fields), "pieces out of order");
  assert.ok(!quoted("Paycheck lands... invest in stocks", fields));
  assert.ok(!quoted("aycheck lands", fields), "part of a word");
  assert.ok(!quoted("saving", fields), "one word that is not a whole field");
  assert.ok(quoted("Flip the order", fields));
  assert.ok(!quoted("ON SCREEN", fields), "the layout's labels are not the script");
  assert.ok(!quoted("hook spoken", fields));
  assert.ok(!quoted("", fields));
  assert.ok(quoted("Willpower doesn't get a vote", fields));
});

test("readJudgment keeps 0 to 2, drops a 1 or 2 without a real quote, ignores non-numbers, and refuses non-JSON", () => {
  const fields = scriptFields(parseCreatorFormat(RAW));
  const reply = `Here you go: {"scores": {"H1": {"score": 2, "quote": "You're not bad at saving"}, "H2": {"score": 2, "quote": "made up line"}, "H3": {"score": 0, "quote": ""}, "H4": {"score": 3, "quote": "Flip the order"}, "H5": {"score": "2", "quote": "Flip the order"}, "S1": {"score": null}, "S2": {"score": true, "quote": "Flip the order"}, "ZZ": {"score": 2}}, "verdict": "Fine."}`;
  const read = readJudgment(reply, fields);
  assert.deepEqual(read.scores, { H1: 2, H3: 0 });
  assert.equal(read.dropped, 1);
  assert.equal(read.verdict, "Fine.");
  assert.equal(readJudgment("no json here", fields), null);
  assert.equal(readJudgment("{not json}", fields), null);
});

test("judgeMessage lists every criterion and reverses anchors in the second ordering", () => {
  const brief = byId.get("P01");
  const order = shuffled(CRITERION_IDS, "x|0");
  assert.deepEqual([...order].sort(), [...CRITERION_IDS].sort());
  const m0 = judgeMessage(brief, "SCRIPT TEXT", order, 0);
  const m1 = judgeMessage(brief, "SCRIPT TEXT", order, 1);
  for (const id of CRITERION_IDS) assert.match(m0, new RegExp(`^${id} `, "m"));
  assert.match(m0, /H1 Topic clarity in the first spoken sentence: 0 = the topic is unclear/);
  assert.match(m1, /H1 Topic clarity in the first spoken sentence: 2 = the first spoken sentence gives a concrete topic/);
  assert.match(JUDGE_SYSTEM, /Reply with JSON only/);
});

test("rng and shuffles are seeded", () => {
  assert.equal(rng("a")(), rng("a")());
  assert.notEqual(rng("a")(), rng("b")());
  assert.deepEqual(shuffled(CRITERION_IDS, "s"), shuffled(CRITERION_IDS, "s"));
});

test("severities find a stricter judge and sum to zero", () => {
  const values = new Map();
  for (let i = 0; i < 10; i++) values.set(`i${i}`, new Map([["easy", 0.5 + i * 0.03 + 0.1], ["hard", 0.5 + i * 0.03]]));
  const sev = severities(values);
  assert.ok(Math.abs(sev.get("easy") - 0.05) < 1e-9);
  assert.ok(Math.abs(sev.get("hard") + 0.05) < 1e-9);
});

const full = (value) => Object.fromEntries(CRITERION_IDS.map((id) => [id, value]));
const fullChecks = { D1: 2, D2: 2, D3: 2, D4: 2, D5: 2, D4h: 2 };

const both = (row) => [{ ...row, perm: 0 }, { ...row, perm: 1 }];

test("scoreItems: only judges the keep rule allows count, and a low truth score caps the script at 40", () => {
  const items = [
    { brief: "P01", contestant: "a", sample: 1, ok: true, checks: fullChecks },
    { brief: "P01", contestant: "b", sample: 1, ok: true, checks: fullChecks },
  ];
  const judgments = [
    ...both({ brief: "P01", contestant: "a", sample: 1, judge: "ja", scores: full(2) }),
    ...both({ brief: "P01", contestant: "a", sample: 1, judge: "jb", scores: full(1) }),
    ...both({ brief: "P01", contestant: "b", sample: 1, judge: "ja", scores: { ...full(2), S9: 0 } }),
  ];
  const keep = (contestant, judge) => `j${contestant}` !== judge;
  const { items: scored } = scoreItems(items, judgments, { keep });
  const a = scored.find((s) => s.contestant === "a");
  const b = scored.find((s) => s.contestant === "b");
  assert.equal(a.hooks, 100 * (0.8 * 0.5 + 0.2));
  assert.equal(b.gated, true);
  assert.equal(b.script, 40);
  assert.equal(b.hooks, 100);
});

test("scoreItems: grades with one ordering, no truth grade or too few criteria are left out, never scored as perfect", () => {
  const items = [{ brief: "P01", contestant: "a", sample: 1, ok: true, checks: fullChecks }];
  const cases = [
    [{ brief: "P01", contestant: "a", sample: 1, judge: "j", perm: 0, scores: full(2) }],
    both({ brief: "P01", contestant: "a", sample: 1, judge: "j", scores: { H1: 2 } }),
    both({ brief: "P01", contestant: "a", sample: 1, judge: "j", scores: (({ S9, ...rest }) => rest)(full(2)) }),
    both({ brief: "P01", contestant: "a", sample: 1, judge: "j", scores: {} }),
    [{ brief: "P01", contestant: "a", sample: 1, judge: "j", perm: 0, scores: full(2) }, { brief: "P01", contestant: "a", sample: 1, judge: "j", perm: 1, scores: {} }],
  ];
  for (const judgments of cases) {
    const { items: scored, incomplete } = scoreItems(items, judgments, { adjust: true });
    assert.equal(scored[0].scored, false);
    assert.equal(scored[0].index, null);
    assert.equal(incomplete, 1);
    assert.deepEqual(summarize(scored, "index"), []);
  }
});

test("summarize gives a seeded range over briefs and tiers group overlapping ranges", () => {
  const items = [];
  for (const [contestant, base] of [["x", 80], ["y", 80], ["z", 50]]) {
    for (let i = 0; i < 8; i++) items.push({ brief: `B${i}`, contestant, sample: 1, scored: true, index: base + (i % 3) });
  }
  const summary = summarize(items, "index");
  assert.deepEqual(summary, summarize(items, "index"));
  const x = summary.find((s) => s.contestant === "x");
  assert.equal(x.n, 8);
  assert.ok(x.low <= x.mean && x.mean <= x.high);
  const ranked = tiers(summary);
  assert.deepEqual(ranked.map((r) => [r.contestant, r.tier]), [["x", 1], ["y", 1], ["z", 2]]);
});

test("contestant requests carry no system prompt and default settings; keys are required", () => {
  const env = { ANTHROPIC_API_KEY: "k1", OPENAI_API_KEY: "k2", GEMINI_API_KEY: "k3" };
  const anthropic = request({ id: "a", api: "anthropic", model: "claude-opus-5-5" }, { prompt: "P", maxTokens: 16000 }, env);
  assert.deepEqual(anthropic.body, { model: "claude-opus-5-5", max_tokens: 16000, messages: [{ role: "user", content: "P" }] });
  const openai = request({ id: "o", api: "openai", model: "gpt-6.2-sol" }, { prompt: "P", maxTokens: 16000 }, env);
  assert.deepEqual(openai.body, { model: "gpt-6.2-sol", max_output_tokens: 16000, input: "P" });
  const google = request({ id: "g", api: "google", model: "gemini-4-neon" }, { prompt: "P", maxTokens: 16000 }, env);
  assert.equal(google.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:generateContent");
  assert.deepEqual(google.body, { contents: [{ role: "user", parts: [{ text: "P" }] }], generationConfig: { maxOutputTokens: 16000 } });
  assert.equal(google.read({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: "answer" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7 } }).usage.output, 12);
  const judge = request({ id: "a", api: "anthropic", model: "m" }, { prompt: "P", system: "S", maxTokens: 10, judge: true }, env);
  assert.equal(judge.body.system, "S");
  assert.throws(() => request({ id: "a", api: "anthropic", model: "m" }, { prompt: "P", maxTokens: 1 }, {}), /ANTHROPIC_API_KEY/);
  assert.equal(worstCaseUsd({ input: 3, output: 15 }, 3000, 1000), (3200 * 3 + 1000 * 15) / 1e6);
  assert.ok(refusedBeforeWork(new HttpError("x", 401)));
  assert.ok(!refusedBeforeWork(new HttpError("x", 500)));
  assert.ok(!refusedBeforeWork(new Error("timeout")));
});

const run = (args, env = {}) => spawnSync(process.execPath, [BENCH, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
const briefsFile = join(ROOT, "briefs/pilot-2026-10-18.json");

test("CLI: prompts prints a brief's prompt; help exits 0; bad input exits 2", () => {
  const out = run(["prompts", "--briefs", briefsFile, "--brief", "P09"]);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Write a voiceover script for a YouTube Shorts video\./);
  assert.equal(run(["--help"]).status, 0);
  assert.equal(run(["-h"]).status, 0);
  assert.equal(run(["prompts"]).status, 2);
  assert.equal(run(["nope"]).status, 2);
  assert.equal(run([]).status, 2);
});

test("CLI: generate refuses zero rates, a missing key, a locked folder and a changed resume, and stops before passing the cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-"));
  const rates = join(dir, "rates.json");
  const args = (runDir, more = []) => ["generate", "--briefs", briefsFile, "--contestants", "claude-opus-5-5", "--run", runDir, "--rates", rates, "--max-usd", "1", ...more];
  const key = { ANTHROPIC_API_KEY: "test-key-not-real" };
  writeFileSync(rates, JSON.stringify({ "claude-opus-5-5": { input: 0, output: 0 } }));
  assert.equal(run(args(join(dir, "a")), key).status, 2);
  const noRates = run(["generate", "--briefs", briefsFile, "--contestants", "claude-opus-5-5", "--run", join(dir, "a"), "--max-usd", "1"], key);
  assert.equal(noRates.status, 2);
  assert.match(noRates.stderr, /--rates is required/);
  writeFileSync(rates, JSON.stringify({ "claude-opus-5-5": { input: 5, output: 100 } }));
  const noKey = run(args(join(dir, "a")));
  assert.equal(noKey.status, 2);
  assert.match(noKey.stderr, /ANTHROPIC_API_KEY/);
  const stopped = run(args(join(dir, "a")), key);
  assert.equal(stopped.status, 3, stopped.stderr);
  assert.match(stopped.stdout, /could pass the \$1 cap/);
  assert.equal(readdirSync(join(dir, "a")).includes(".lock"), false, "the lock is released");
  writeFileSync(join(dir, "a", ".lock"), "12345");
  assert.equal(run(args(join(dir, "a")), key).status, 2);
  const otherBriefs = join(dir, "briefs.json");
  writeFileSync(otherBriefs, JSON.stringify({ briefs: briefs.slice(0, 2) }));
  mkdirSync(join(dir, "b"));
  assert.equal(run(args(join(dir, "b")), key).status, 3);
  const changed = run(["generate", "--briefs", otherBriefs, "--contestants", "claude-opus-5-5", "--run", join(dir, "b"), "--rates", rates, "--max-usd", "1"], key);
  assert.equal(changed.status, 2);
  assert.match(changed.stderr, /different briefsSha256/);
  mkdirSync(join(dir, "c"));
  writeFileSync(rates, JSON.stringify({ "claude-opus-5-5": { input: 0.001, output: 0.001 } }));
  writeFileSync(join(dir, "c", "ledger.jsonl"), `${JSON.stringify({ kind: "pending", id: "x", worst: 0.99999 })}\n`);
  const pending = run(args(join(dir, "c"), ["--concurrency", "3"]), key);
  assert.equal(pending.status, 3, "a call that never settled still counts at its worst case");
  writeFileSync(join(dir, "c", "ledger.jsonl"), `${JSON.stringify({ kind: "pending", id: "x", worst: 0.99999 })}\n${JSON.stringify({ kind: "settled", id: "x", usd: 0.99999 })}\n`);
  assert.equal(run(args(join(dir, "c")), key).status, 3, "a settled call counts at its real cost");
});

test("CLI: judge-pack uses opaque names, then score counts only judges from another maker and renders pages", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-"));
  const runDir = join(dir, "run");
  for (const contestant of ["claude-opus-5-5", "gpt-6.2-sol"]) {
    mkdirSync(join(runDir, "outputs", contestant), { recursive: true });
    writeFileSync(join(runDir, "outputs", contestant, "P01-1.txt"), RAW);
  }
  writeFileSync(join(runDir, "outputs", "gpt-6.2-sol", "P02-1.txt"), "I cannot help with that.");
  writeFileSync(join(runDir, "outputs", ".DS_Store"), "");
  for (const judge of ["judge-openai", "judge-anthropic"]) {
    const pack = run(["judge-pack", "--briefs", briefsFile, "--run", runDir, "--judge", judge]);
    assert.equal(pack.status, 0, pack.stderr);
    assert.match(pack.stdout, /^2 judge prompts/, "a judge packs only the other maker's scripts");
  }
  assert.match(run(["judge-pack", "--briefs", briefsFile, "--run", runDir, "--judge", "judge-openai"]).stdout, /^0 judge prompts/, "a second pack reuses the names");
  const names = readdirSync(join(runDir, "judging", "judge-anthropic"));
  assert.ok(names.every((n) => /^[0-9a-f]{16}\.prompt\.txt$/.test(n)), "pack file names say nothing about the author");
  const keys = JSON.parse(readFileSync(join(runDir, "judging-keys", "judge-anthropic.json"), "utf8"));
  const reply = (value) => JSON.stringify({ scores: Object.fromEntries(CRITERION_IDS.map((id) => [id, { score: value, quote: "You're not bad at saving" }])), verdict: "ok" });
  for (const [name, key] of Object.entries(keys)) {
    const prompt = readFileSync(join(runDir, "judging", "judge-anthropic", `${name}.prompt.txt`), "utf8");
    assert.ok(prompt.startsWith(JUDGE_SYSTEM));
    assert.doesNotMatch(prompt, /claude|gpt|opus|sol\b/i);
    writeFileSync(join(runDir, "judging", "judge-anthropic", `${name}.reply.txt`), reply(key.contestant === "claude-opus-5-5" ? 2 : 1));
  }
  writeFileSync(join(runDir, "judging", ".DS_Store"), "");
  const scored = run(["score", "--briefs", briefsFile, "--run", runDir]);
  assert.equal(scored.status, 0, scored.stderr);
  const results = JSON.parse(readFileSync(join(runDir, "results.json"), "utf8"));
  assert.equal(results.counts.scripts, 3);
  assert.equal(results.counts.unparsed, 1);
  assert.equal(results.counts.judgments, 2);
  const opus = results.items.find((i) => i.contestant === "claude-opus-5-5");
  const sol = results.items.find((i) => i.contestant === "gpt-6.2-sol" && i.brief === "P01");
  assert.equal(opus.scored, false, "an Anthropic judge never counts toward an Anthropic model");
  assert.equal(sol.scored, true);
  assert.equal(typeof sol.script, "number", "the numeric script score survives serialization");
  assert.deepEqual(results.coverage.find((c) => c.contestant === "claude-opus-5-5"), { contestant: "claude-opus-5-5", expected: 16, scripts: 1, unparsed: 0, scored: 0 });
  assert.match(scored.stdout, /\| Tier \| Contestant \|/);
  assert.equal(render(runDir), 16);
  assert.match(readFileSync(join(runDir, "scripts", "P01.md"), "utf8"), /## GPT-6\.2 Sol, script 1/);
});

test("plain asks: one line each, sent as is, never mixed with creator briefs", () => {
  const plain = readBriefs(JSON.parse(readFileSync(join(ROOT, "briefs/plain-2026-11-19.json"), "utf8")));
  assert.equal(plain.length, 16);
  assert.equal(creatorPrompt(plain[0]), "Make me a video about paying yourself first, 45 seconds long, for TikTok.");
  for (const b of plain) {
    assert.match(b.ask, new RegExp(`^Make me a video about .+, ${b.targetSec} seconds long, for ${PLATFORM_NAMES[b.platform]}\\.$`));
    assert.equal(b.platform, byId.get(b.id).platform);
    assert.equal(b.targetSec, byId.get(b.id).targetSec);
  }
  assert.throws(() => readBriefs([plain[0], briefs[1]]), /not both/);
  assert.throws(() => readBriefs([{ ...plain[0], ask: "two\nlines" }]), /one line/);
});

test("plain scripts are scored on the judges alone", () => {
  const items = [{ brief: "P01", contestant: "a", sample: 1, ok: true, plain: true, checks: null }];
  const judgments = both({ brief: "P01", contestant: "a", sample: 1, judge: "j", scores: full(1) });
  const { items: scored } = scoreItems(items, judgments, {});
  assert.equal(scored[0].scored, true);
  assert.equal(scored[0].hooks, 50);
  assert.equal(scored[0].facts, 50);
});

test("CLI: a plain run packs the whole reply and scores it", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-"));
  const runDir = join(dir, "run");
  const plainFile = join(ROOT, "briefs/plain-2026-11-19.json");
  mkdirSync(join(runDir, "outputs", "gpt-6.2-sol"), { recursive: true });
  const reply = "Here is a 45 second script.\n\nYou're not bad at saving. You're saving last. Move twenty-five dollars on payday morning.";
  writeFileSync(join(runDir, "outputs", "gpt-6.2-sol", "P01-1.txt"), reply);
  assert.equal(run(["judge-pack", "--briefs", plainFile, "--run", runDir, "--judge", "judge-anthropic"]).status, 0);
  const keys = JSON.parse(readFileSync(join(runDir, "judging-keys", "judge-anthropic.json"), "utf8"));
  for (const name of Object.keys(keys)) {
    const prompt = readFileSync(join(runDir, "judging", "judge-anthropic", `${name}.prompt.txt`), "utf8");
    assert.match(prompt, /The person asked, in these words: Make me a video about paying yourself first/);
    assert.ok(prompt.includes("Move twenty-five dollars on payday morning."));
    writeFileSync(join(runDir, "judging", "judge-anthropic", `${name}.reply.txt`), JSON.stringify({ scores: Object.fromEntries(CRITERION_IDS.map((id) => [id, { score: 2, quote: "saving last" }])) }));
  }
  assert.equal(run(["score", "--briefs", plainFile, "--run", runDir]).status, 0);
  const results = JSON.parse(readFileSync(join(runDir, "results.json"), "utf8"));
  assert.equal(results.items[0].scored, true);
  assert.equal(results.items[0].index, 100);
  assert.equal(results.briefs[0].ask, "Make me a video about paying yourself first, 45 seconds long, for TikTok.");
  assert.equal(render(runDir), 16);
  assert.ok(readFileSync(join(runDir, "scripts", "P01.md"), "utf8").includes("Move twenty-five dollars"));
  for (const name of Object.keys(keys)) rmSync(join(runDir, "judging", "judge-anthropic", `${name}.prompt.txt`));
  assert.equal(run(["score", "--briefs", plainFile, "--run", runDir]).status, 0, "a published run needs no prompt files");
  writeFileSync(join(runDir, "outputs", "gpt-6.2-sol", "P01-1.txt"), `${reply} One more line.`);
  assert.equal(run(["score", "--briefs", plainFile, "--run", runDir]).status, 2, "a reply changed after judging is refused");
});

test("tiers compare every model with each tier's leader, not only the one before it", () => {
  const rows = [
    { contestant: "a", mean: 85, low: 81.7, high: 88.7 },
    { contestant: "b", mean: 79, low: 76, high: 81.5 },
    { contestant: "c", mean: 78, low: 72, high: 83.9 },
  ];
  assert.deepEqual(tiers(rows).map((r) => [r.contestant, r.tier]), [["a", 1], ["c", 1], ["b", 2]]);
});

test("versusLeader pairs briefs", () => {
  const items = [];
  for (let i = 0; i < 6; i++) {
    items.push({ brief: `B${i}`, contestant: "top", sample: 1, scored: true, index: 80 + i });
    items.push({ brief: `B${i}`, contestant: "next", sample: 1, scored: true, index: 78 + i });
  }
  const [row] = versusLeader(items, "index", "top");
  assert.equal(row.diff, -2);
  assert.equal(row.low, -2);
  assert.equal(row.high, -2);
  assert.equal(row.n, 6);
});

test("the truth cap reads strictness-adjusted grades, so a lenient judge cannot shield a reply", () => {
  const items = ["B1", "B2", "B3"].map((brief) => ({ brief, contestant: "b", sample: 1, ok: true, plain: true, checks: null }));
  items.push({ brief: "A1", contestant: "a", sample: 1, ok: true, plain: true, checks: null });
  const judgments = [];
  for (const brief of ["B1", "B2", "B3"]) {
    judgments.push(...both({ brief, contestant: "b", sample: 1, judge: "lenient", scores: full(2) }));
    judgments.push(...both({ brief, contestant: "b", sample: 1, judge: "middle", scores: { ...full(2), S9: 1 } }));
    judgments.push(...both({ brief, contestant: "b", sample: 1, judge: "strict", scores: { ...full(2), S9: 0 } }));
  }
  judgments.push(...both({ brief: "A1", contestant: "a", sample: 1, judge: "lenient", scores: { ...full(2), S9: 1 } }));
  judgments.push(...both({ brief: "A1", contestant: "a", sample: 1, judge: "middle", scores: { ...full(2), S9: 0 } }));
  const options = { adjust: true, keep: (contestant, judge) => !(contestant === "a" && judge === "strict") };
  const raw = scoreItems(items, judgments, { ...options, gate: "raw" }).items.find((i) => i.contestant === "a");
  const adjusted = scoreItems(items, judgments, options).items.find((i) => i.contestant === "a");
  assert.equal(raw.gated, false, "the pilot's rule: a mean truth grade of 0.5 out of 2 is not capped");
  assert.equal(adjusted.gated, true, "once the lenient judge's strictness is removed, the reply is under the cap line");
});

test("refusals are kept as answers", () => {
  const env = { OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "k" };
  const openai = request({ id: "o", api: "openai", model: "m" }, { prompt: "P", maxTokens: 10 }, env);
  assert.equal(openai.read({ output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }], usage: { input_tokens: 5, output_tokens: 3 } }).text, "[refusal] I can't help with that.");
  const anthropic = request({ id: "a", api: "anthropic", model: "m" }, { prompt: "P", maxTokens: 10 }, env);
  assert.equal(anthropic.read({ content: [], stop_reason: "refusal", usage: {} }).text, "[refusal]");
  const google = request({ id: "g", api: "google", model: "m" }, { prompt: "P", maxTokens: 10 }, env);
  assert.equal(google.read({ candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] }).text, "[blocked: SAFETY]");
  assert.equal(google.read({ candidates: [{ content: { parts: [{ text: "x" }] } }], usageMetadata: { promptTokenCount: 12, thoughtsTokenCount: 5 } }).usage.output, 0, "no reply count: output unknown");
});

test("judge packs store a random criterion order and score counts missing judges", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-"));
  const runDir = join(dir, "run");
  const plainFile = join(ROOT, "briefs/plain-2026-11-19.json");
  mkdirSync(join(runDir, "outputs", "gemini-4-neon"), { recursive: true });
  writeFileSync(join(runDir, "outputs", "gemini-4-neon", "P01-1.txt"), "Save first. Move twenty-five dollars on payday morning.");
  for (const judge of ["judge-openai", "judge-anthropic"]) assert.equal(run(["judge-pack", "--briefs", plainFile, "--run", runDir, "--judge", judge]).status, 0);
  const keys = JSON.parse(readFileSync(join(runDir, "judging-keys", "judge-openai.json"), "utf8"));
  for (const k of Object.values(keys)) assert.deepEqual([...k.order].sort(), [...CRITERION_IDS].sort());
  for (const name of Object.keys(keys)) writeFileSync(join(runDir, "judging", "judge-openai", `${name}.reply.txt`), JSON.stringify({ scores: Object.fromEntries(CRITERION_IDS.map((id) => [id, { score: 2, quote: "Move twenty-five dollars" }])) }));
  const out = run(["score", "--briefs", plainFile, "--run", runDir]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(readFileSync(join(runDir, "results.json"), "utf8")).counts.missingReplies, 2, "the Anthropic judge's two replies are missing");
  rmSync(join(runDir, "judging", "judge-anthropic"), { recursive: true });
  assert.equal(run(["score", "--briefs", plainFile, "--run", runDir]).status, 0);
  assert.equal(JSON.parse(readFileSync(join(runDir, "results.json"), "utf8")).counts.missingReplies, 2, "a judge whose folder is gone still counts");
});

console.log(`ok: ${passed} tests passed`);
