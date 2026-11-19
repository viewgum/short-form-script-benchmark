#!/usr/bin/env node
// Writes one readable page per brief from a results.json (the pilot's, or one `score` wrote): every contestant's scripts.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PLATFORM_NAMES } from "../lib/prompt.mjs";

const cell = (text) => String(text ?? "none").replace(/\|/g, "\\|").replace(/\n+/g, " ");

export function pageFor(brief, outputs, names) {
  const rows = [
    `# ${brief.id}: ${PLATFORM_NAMES[brief.platform]}, ${brief.targetSec} seconds`,
    "",
    `**Audience:** ${brief.audience}`,
    "",
    `**Topic:** ${brief.topic}`,
    "",
    "Each script below is the model's reply read into one layout, the text the judges saw. Alternative hooks are left out, as judges did not see them.",
  ];
  for (const output of outputs) {
    const s = output.script;
    rows.push("", `## ${names.get(output.contestant) ?? output.contestant}, script ${output.sample}`, "");
    rows.push(`**Hook:** ${s.hook}`, "", `**Hook text:** ${s.hookText ?? "none"}`, "", `**Hook visual:** ${s.hookVisual ?? "none"}`, "");
    rows.push("| # | Spoken | On screen | Visual |", "|---|---|---|---|");
    s.lines.forEach((line, i) => rows.push(`| ${i + 1} | ${cell(line.say)} | ${cell(line.text)} | ${cell(line.visual)} |`));
    rows.push("", `**Close:** ${s.close ?? "none"}`);
  }
  return `${rows.join("\n")}\n`;
}

/** Writes dir/scripts/<brief>.md for every brief in dir/results.json; returns how many pages. */
export function render(dir) {
  const results = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
  const names = new Map((results.contestants ?? []).map((c) => [c.id, c.name]));
  const out = join(dir, "scripts");
  mkdirSync(out, { recursive: true });
  for (const brief of results.briefs) {
    const outputs = results.outputs.filter((o) => o.brief === brief.id).sort((a, b) => a.contestant.localeCompare(b.contestant) || a.sample - b.sample);
    writeFileSync(join(out, `${brief.id}.md`), pageFor(brief, outputs, names));
  }
  return results.briefs.length;
}

const invoked = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) {
  if (!process.argv[2]) {
    console.error("usage: node scripts/render-scripts.mjs <run or results folder>");
    process.exit(2);
  }
  const dir = resolve(process.argv[2]);
  console.log(`${render(dir)} pages in ${join(dir, "scripts")}`);
}
