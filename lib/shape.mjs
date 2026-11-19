// Reads a reply in the prompt's format into one plain shape, so judges see the same layout whoever wrote it, and runs the checks.
import { targetWords } from "./prompt.mjs";

const clean = (value) => {
  const text = value?.replace(/\*\*/g, "").replace(/^["'\s]+|["'\s]+$/g, "").trim();
  return text && !/^(none|n\/a|-|no text)\.?$/i.test(text) ? text : undefined;
};
const field = (line, label) => {
  const match = new RegExp(`${label}\\s*:\\s*([^|]*)`, "i").exec(line);
  return match ? clean(match[1]) : undefined;
};
/** A line row's labelled part: the pipe-separated segment that starts with the label, so a spoken "text:" is never read as TEXT. */
const segment = (row, label) => {
  for (const part of row.split("|")) {
    const match = new RegExp(`^(?:\\d+[.)]\\s*)?${label}\\s*:\\s*(.*)$`, "i").exec(part.trim());
    if (match) return clean(match[1]);
  }
  return undefined;
};

/** The reply as { hook, hookText, hookVisual, lines: [{ say, text, visual }], close, altHooks }; null when no spoken lines are found. */
export function parseCreatorFormat(raw) {
  const rows = String(raw ?? "").replace(/\r/g, "").split("\n").map((row) => row.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim()).filter(Boolean);
  let hook;
  let hookText;
  let hookVisual;
  let close;
  const lines = [];
  const altHooks = [];
  let section = "head";
  for (const row of rows) {
    if (/^HOOK TEXT\s*:/i.test(row)) hookText = field(row, "HOOK TEXT");
    else if (/^HOOK VISUAL\s*:/i.test(row)) hookVisual = field(row, "HOOK VISUAL");
    else if (/^HOOK\s*:/i.test(row)) hook = field(row, "HOOK");
    else if (/^LINES\s*:?$/i.test(row)) section = "lines";
    else if (/^CLOSE\s*:/i.test(row)) { close = field(row, "CLOSE"); section = "head"; }
    else if (/^ALT(ERNATE)? HOOKS\s*:?/i.test(row)) section = "alts";
    else if (section === "alts" && /^[-*\d.)\s]+/.test(row)) { const alt = clean(row.replace(/^[-*\d.)\s]+/, "")); if (alt) altHooks.push(alt); }
    else if (/SAY\s*:/i.test(row)) {
      const say = segment(row, "SAY");
      if (say) {
        const line = { say };
        const text = segment(row, "TEXT");
        const visual = segment(row, "VISUAL");
        if (text) line.text = text;
        if (visual) line.visual = visual;
        lines.push(line);
      }
    }
  }
  if (!hook && lines.length) hook = lines.shift().say;
  if (!hook || !lines.length) return null;
  return { hook, hookText, hookVisual, lines, close, altHooks: altHooks.slice(0, 3) };
}

/** The layout judges read: identical labels for every contestant, alternative hooks left out. */
export function renderForJudge(script) {
  return [
    `HOOK (spoken): ${script.hook}`,
    `HOOK (on screen): ${script.hookText ?? "none"}`,
    `HOOK (visual): ${script.hookVisual ?? "none"}`,
    "LINES:",
    ...script.lines.map((line, i) => `${i + 1}. SAY: ${line.say} | ON SCREEN: ${line.text ?? "none"} | VISUAL: ${line.visual ?? "none"}`),
    `CLOSE (spoken): ${script.close ?? "none"}`,
  ].join("\n");
}

/** The script's own words, field by field, with no labels: what a judge's quote must come from. */
export const scriptFields = (script) => [script.hook, script.hookText, script.hookVisual, ...script.lines.flatMap((line) => [line.say, line.text, line.visual]), script.close].filter(Boolean);

export const spokenLines = (script) => [script.hook, ...script.lines.map((line) => line.say), ...(script.close ? [script.close] : [])];
export const spokenText = (script) => spokenLines(script).join(" ");

export const words = (text) => String(text).split(/\s+/).map((word) => word.replace(/^[^\p{L}\p{N}$%]+|[^\p{L}\p{N}%]+$/gu, "")).filter(Boolean);
export const sentences = (text) => String(text).split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter((part) => words(part).length);

const GREETINGS = /^(hey|hi|hello|welcome|so|today|okay|ok|alright|guys|in this video)\b/i;

const FIGURE = /[$£€]?\d[\d,.]*(?!\d|st\b|nd\b|rd\b|th\b)\s*%?/g;
/** A figure's form for comparing with the brief: its currency mark, digits and percent sign, without commas or a trailing stop. */
const figureForm = (raw) => {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[$£€%\s]/g, "").replace(/[,.]$/, "").replace(/,/g, "");
  return `${/^[$£€]/.test(trimmed) ? trimmed[0] : ""}${digits}${/%$/.test(trimmed) ? "%" : ""}`;
};

/**
 * Figures in digits that state a fact (a percent, money, or a number above ten) and that the brief did not give in the same
 * form: "36 hours" in a brief covers 36, not $36 or 36%. Figures written in words are not read.
 */
export function unsourcedNumbers(text, brief) {
  const given = new Set((`${brief.topic} ${brief.audience}`.match(FIGURE) ?? []).map(figureForm));
  const found = String(text).match(FIGURE) ?? [];
  return found.map((raw) => raw.trim()).filter((raw) => {
    const form = figureForm(raw);
    if (given.has(form)) return false;
    const digits = form.replace(/[$£€%]/g, "");
    return /[$£€%]/.test(raw) || Number(digits) > 10;
  });
}

const grade = (two, one) => (two ? 2 : one ? 1 : 0);

/** D1 to D5 and D4h for one script, plus the spoken word count and the unsourced figures found. */
export function checks(script, brief) {
  const spoken = spokenText(script);
  const count = words(spoken).length;
  const target = targetWords(brief);
  const off = Math.abs(count - target) / target;
  const first = sentences(script.hook)[0] ?? script.hook;
  const firstWords = words(first).length;
  const greeting = GREETINGS.test(script.hook.trim());
  const lengths = sentences(spoken).map((sentence) => words(sentence).length);
  const mean = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length);
  const longest = Math.max(0, ...lengths);
  const texts = [script.hookText, ...script.lines.map((line) => line.text)].filter(Boolean);
  const longestText = Math.max(0, ...texts.map((text) => words(text).length));
  const hookWords = script.hookText ? words(script.hookText).length : 0;
  const unsourced = unsourcedNumbers(spoken, brief);
  return {
    D1: grade(off <= 0.15, off <= 0.3),
    D2: greeting ? 0 : grade(firstWords <= 15, firstWords <= 20),
    D3: grade(mean <= 14 && longest <= 25, mean <= 18),
    D4: grade(Boolean(script.hookText) && longestText <= 7, Boolean(script.hookText) && longestText <= 10),
    D5: grade(unsourced.length === 0, unsourced.length === 1),
    D4h: grade(hookWords > 0 && hookWords <= 7, hookWords > 0 && hookWords <= 10),
    spokenWords: count,
    unsourcedNumbers: unsourced,
  };
}
