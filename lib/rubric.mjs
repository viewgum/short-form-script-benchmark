// The judges' rubric and instructions, the checks code runs, and the scoring rules in words. Fixed like the prompt.
import { briefText } from "./prompt.mjs";

export const CRITERIA = [
  { id: "H1", name: "Topic clarity in the first spoken sentence", anchors: [
    "the topic is unclear after the first spoken sentence", "the first spoken sentence names the topic but vaguely", "the first spoken sentence gives a concrete topic and outcome, with one reading"] },
  { id: "H2", name: "Curiosity or stakes", anchors: [
    "a plain statement with no gap", "a generic tease or a stock \"the truth is\" contrast", "a specific contrast or concrete stakes the viewer wants resolved"] },
  { id: "H3", name: "Relevance to the audience", anchors: [
    "about the speaker, no stakes for the viewer", "the viewer is implied", "speaks to the stated audience with an outcome they need"] },
  { id: "H4", name: "Promise of what is coming", anchors: [
    "no signal of what the end holds", "an implied ending", "a visible promise or mechanism in the first five seconds"] },
  { id: "H5", name: "Hook on mute", anchors: [
    "no text on screen in the opening (an overlay, or readable words on a prop or sign the script shows), or text that makes no sense without sound", "opening text on screen that is long, busy or gives the answer away", "opening text on screen of 7 words or fewer that makes sense on mute and holds back the answer"] },
  { id: "S1", name: "Brief fidelity", anchors: [
    "misses the brief's topic or point", "on topic but drops or changes the brief's key point", "delivers the brief's topic and key point for the stated audience"] },
  { id: "S2", name: "Novelty", anchors: [
    "common knowledge for this audience", "one familiar point with a new angle", "at least one point the viewer likely does not know, stated plainly"] },
  { id: "S3", name: "Progression", anchors: [
    "lines repeat or stall", "some change between lines", "every line changes something, joined by but, so or therefore, building to the end"] },
  { id: "S4", name: "Specificity", anchors: [
    "abstractions and platitudes", "some concrete nouns", "named objects, numbers, cases or steps in every line"] },
  { id: "S5", name: "Payoff", anchors: [
    "never delivers what the hook promised, or buries it", "delivers it but padded or late", "delivers the promised payoff clearly near the end, then at most one line"] },
  { id: "S6", name: "Ending and call to action", anchors: [
    "bait, several calls to action, a summary, or a call to action before the payoff", "generic but harmless", "one natural closing line or call to action that fits, or a clean stop"] },
  { id: "S7", name: "Sounds spoken", anchors: [
    "reads like an essay or ad copy", "mostly spoken", "sounds like a person talking: contractions, plain words, no machine register"] },
  { id: "S8", name: "Edit readiness", anchors: [
    "no visual intent beyond a face or generic footage", "visuals listed but generic or decorative", "the visuals carry part of the story and at least one is specific to the content"] },
  { id: "S9", name: "Truth and safety", anchors: [
    "a claim that is likely false, an invented statistic, quote or testimonial, or risky advice", "a vague or overstated claim", "clean"] },
];

export const CRITERION_IDS = CRITERIA.map((criterion) => criterion.id);

export const JUDGE_SYSTEM = [
  "You grade short-form video scripts (TikTok, YouTube Shorts, Instagram Reels, Facebook Reels) for a published benchmark.",
  "You get a creator's brief and one script. Grade only what is written. You are not told who or what wrote it; do not guess.",
  "Score each criterion 0, 1 or 2 against its anchors. For every score, copy the exact words from the script that justify it (at most 20 words).",
  "If nothing in the script earns a 1 or 2, give 0 and quote the closest line. Length and polish do not earn points on their own.",
  "Reply with JSON only, in this shape: {\"scores\": {\"<id>\": {\"score\": 0, \"quote\": \"...\", \"why\": \"at most 15 words\"}}, \"verdict\": \"one sentence\"}.",
].join("\n");

/** The judge's message: criteria in the given order, anchors forwards (perm 0) or backwards (perm 1). */
export function judgeMessage(brief, scriptText, order, perm) {
  const byId = new Map(CRITERIA.map((criterion) => [criterion.id, criterion]));
  const lines = order.map((id) => {
    const criterion = byId.get(id);
    if (!criterion) throw new Error(`unknown criterion ${id}`);
    const anchors = criterion.anchors.map((text, score) => `${score} = ${text}`);
    return `${id} ${criterion.name}: ${(perm === 0 ? anchors : [...anchors].reverse()).join("; ")}`;
  });
  return `BRIEF\n${briefText(brief)}\n\nSCRIPT\n${scriptText}\n\nCRITERIA (score every one)\n${lines.join("\n")}\n\nReturn the JSON.`;
}

const plain = (text) => String(text ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const tokens = (text) => plain(text).split(" ").filter(Boolean);

/**
 * A quote counts when its whole words appear, in order, in the script's own fields (never the layout's labels). An ellipsis
 * splits it into pieces that must appear in that order. At least two words, unless the quote is a whole field.
 */
export function quoted(quote, fields) {
  const list = (Array.isArray(fields) ? fields : [fields]).filter((f) => typeof f === "string" && f.trim());
  const pieces = String(quote ?? "").split(/\.{3}|…/).map(tokens).filter((piece) => piece.length > 0);
  const count = pieces.reduce((n, piece) => n + piece.length, 0);
  if (!pieces.length) return false;
  if (count < 2 && !list.some((f) => tokens(f).join(" ") === pieces[0].join(" "))) return false;
  const hay = list.flatMap((f) => [...tokens(f), "|"]);
  let from = 0;
  for (const piece of pieces) {
    let found = -1;
    for (let i = from; i + piece.length <= hay.length; i++) {
      if (piece.every((word, k) => hay[i + k] === word)) { found = i; break; }
    }
    if (found < 0) return false;
    from = found + piece.length;
  }
  return true;
}

/**
 * A judge's reply as scores: unknown ids and anything but 0, 1 or 2 are ignored, and a 1 or 2 whose quote is not in the
 * script is dropped. Returns null when the reply holds no JSON object.
 */
export function readJudgment(reply, fields) {
  const raw = String(reply ?? "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const given = parsed?.scores;
  if (!given || typeof given !== "object") return null;
  const scores = {};
  let dropped = 0;
  for (const id of CRITERION_IDS) {
    const entry = given[id];
    const score = entry?.score;
    if (typeof score !== "number" || ![0, 1, 2].includes(score)) continue;
    if (score > 0 && !quoted(entry?.quote, fields)) {
      dropped += 1;
      continue;
    }
    scores[id] = score;
  }
  return { scores, dropped, verdict: typeof parsed.verdict === "string" ? parsed.verdict : "" };
}

/** The checks code runs on every script, as published. */
export const CHECK_RULES = [
  { id: "D1", name: "Length", rule: "2 if spoken words are within 15% of the target (seconds x 165 / 60), 1 if within 30%, else 0" },
  { id: "D2", name: "Fast start", rule: "0 if the hook opens with a greeting or filler; else 2 if the first sentence has 15 words or fewer, 1 if 20 or fewer, else 0" },
  { id: "D3", name: "Short sentences", rule: "2 if the mean sentence is 14 words or fewer and none is over 25, 1 if the mean is 18 or fewer, else 0" },
  { id: "D4", name: "On-screen text", rule: "2 if there is hook text and no text is over 7 words, 1 if there is hook text and none is over 10, else 0" },
  { id: "D5", name: "Unsourced figures", rule: "Figures stating a fact (a percent, money, or a number over 10; not ordinals) that are not in the brief: 2 if none, 1 if one, 0 if two or more" },
  { id: "D4h", name: "Hook text", rule: "2 if the hook text has 1 to 7 words, 1 if up to 10, else 0" },
];

export const SCORING_LINES = [
  "Each judge scores 14 criteria 0, 1 or 2, quoting the script, in two orderings that are averaged. A 1 or 2 whose quote is not in the script is dropped.",
  "Only judges from another vendor count toward a contestant's score, after removing each judge's strictness, estimated from every script two judges graded.",
  "Hooks = 100 x (0.8 x the judged hook criteria H1 to H5 + 0.2 x the hook checks D2 and D4h), each as a share of the top score.",
  "Script = 100 x (0.8 x the judged script composite + 0.2 x the checks D1 to D5). The composite weights the hook block 35%, structure 30%, substance 20% and craft 15%.",
  "If the judges' truth score (S9), after each judge's strictness is removed, is under 0.5 of 2, the script score is capped at 40.",
  "Index = (20 x Hooks + 25 x Script) / 45.",
  "Facts = 100 x (0.8 x truth S9 + 0.2 x the unsourced-figures check D5). Visual plan = 100 x (0.8 x the mean of H5 and S8 + 0.2 x the on-screen text check D4).",
  "Ranges are 95% bootstrap intervals over briefs, 2,000 resamples, with each brief's samples averaged first.",
];
