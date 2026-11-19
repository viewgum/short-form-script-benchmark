// The one prompt every contestant gets, filled from a brief. Fixed: change it only with a dated note in CHANGES.md.

export const PLATFORM_NAMES = { tiktok: "TikTok", shorts: "YouTube Shorts", reels: "Instagram Reels", facebook: "Facebook Reels" };

/** Words a minute used for the length target. */
export const WORDS_PER_MIN = 165;

export const targetWords = (brief) => Math.round((brief.targetSec * WORDS_PER_MIN) / 60);

/** A plain brief's prompt is its one-line ask, sent as is; a creator brief fills the long prompt below. */
export const isPlain = (brief) => typeof brief.ask === "string";

export function creatorPrompt(brief) {
  if (isPlain(brief)) return brief.ask;
  return [
    `Write a voiceover script for a ${PLATFORM_NAMES[brief.platform]} video.`,
    "",
    `Creator: ${brief.brand.name}, a ${brief.brand.niche} ${brief.brand.kind}. Voice: ${brief.brand.voice}.`,
    `Audience: ${brief.audience}.`,
    `Topic: ${brief.topic}`,
    `Length: about ${brief.targetSec} seconds, roughly ${targetWords(brief)} spoken words.`,
    "",
    "Make it hold attention from the first second:",
    "- Open with a hook in the first 3 seconds. No greeting, no intro, no \"in this video\".",
    "- Short spoken sentences. Every line adds something new; never repeat a point.",
    "- Deliver the payoff the hook promises, clearly, near the end. Then stop: no summary.",
    "- Only state facts you are confident are true. Do not invent statistics, quotes or testimonials.",
    "- Give short on-screen text (7 words or fewer) and a specific visual for each line.",
    "",
    "Use exactly this format:",
    "HOOK: <first spoken line>",
    "HOOK TEXT: <on-screen text for the hook>",
    "HOOK VISUAL: <what is on screen during the hook>",
    "LINES:",
    "1. SAY: <spoken line> | TEXT: <on-screen text, or none> | VISUAL: <what is on screen>",
    "2. SAY: ... | TEXT: ... | VISUAL: ...",
    "CLOSE: <last spoken line>",
    "ALT HOOKS:",
    "- <another hook>",
    "- <another hook>",
  ].join("\n");
}

/** The brief as judges read it. */
export function briefText(brief) {
  if (isPlain(brief)) {
    return [
      `The person asked, in these words: ${brief.ask}`,
      "The reply may include a preamble, notes to an editor, tables or timings. Grade the video the reply proposes: the words it",
      "would speak (its first spoken line is the hook), its on-screen text and its visuals. Do not grade what the reply says about",
      "itself or whether it can make a video file. Judge truth on everything the video would say or show.",
    ].join("\n");
  }
  return [
    `Platform: ${PLATFORM_NAMES[brief.platform]}. Voiceover script, about ${brief.targetSec} seconds (about ${targetWords(brief)} words).`,
    `Creator: ${brief.brand.name}, a ${brief.brand.niche} ${brief.brand.kind}; voice: ${brief.brand.voice}.`,
    `Audience: ${brief.audience}.`,
    `Topic: ${brief.topic}`,
  ].join("\n");
}

/** Checks a briefs file and returns its briefs; throws with the first problem found. */
export function readBriefs(doc) {
  const briefs = Array.isArray(doc) ? doc : doc?.briefs;
  if (!Array.isArray(briefs) || !briefs.length) throw new Error("briefs: expected a non-empty list");
  const seen = new Set();
  for (const brief of briefs) {
    const where = `brief ${brief?.id ?? "?"}`;
    if (typeof brief?.id !== "string" || seen.has(brief.id)) throw new Error(`${where}: missing or repeated id`);
    seen.add(brief.id);
    if (!PLATFORM_NAMES[brief.platform]) throw new Error(`${where}: platform must be one of ${Object.keys(PLATFORM_NAMES).join(", ")}`);
    if (!Number.isFinite(brief.targetSec) || brief.targetSec <= 0) throw new Error(`${where}: targetSec must be a positive number`);
    if (isPlain(brief)) {
      if (!brief.ask.trim() || /\n/.test(brief.ask)) throw new Error(`${where}: ask must be one line`);
      continue;
    }
    for (const key of ["niche", "audience", "topic"]) if (typeof brief[key] !== "string" || !brief[key].trim()) throw new Error(`${where}: ${key} is required`);
    for (const key of ["name", "kind", "niche", "voice"]) if (typeof brief.brand?.[key] !== "string" || !brief.brand[key].trim()) throw new Error(`${where}: brand.${key} is required`);
  }
  if (new Set(briefs.map(isPlain)).size > 1) throw new Error("briefs: a file holds either plain asks or creator briefs, not both");
  return briefs;
}
