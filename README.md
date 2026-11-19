# Short-form script benchmark

How do AI models score when each is asked, the same way, for a 30 to 60 second video for TikTok, YouTube Shorts, Instagram
Reels or Facebook Reels? This repo holds what you need to run the benchmark: 16 topics as creator briefs and as one-line asks,
the prompts, a 14-criterion rubric, the checks code runs, the scoring code and a runner with a spending cap. The results hold
for these 16 English asks and these judges, nothing wider.

Each model gets one plain call to its maker's own API: in a creator round the prompt below, in a plain round only the one-line
ask; no system prompt, default settings, up to 16,000 output tokens. Judges are not told who wrote a reply, a judge grades only
other makers' replies, and each judge's strictness is estimated from the replies two judges graded.

## Results

Not published here yet. Each round's scores, scripts and judge replies go in `results/<date>/` once the terms of every model
maker in the round have been checked for publishing them. Until then, run it yourself (below) with your own keys.

## What it measures, and what it does not

Measured: judged quality of short voiceover scripts, plus a few checks code can do (length, a fast start, short sentences,
on-screen text, unsourced figures).

Not measured: real views, retention or swipes. Nothing here was posted. A judge's view of a hook is an estimate. English only.

## Method

**The prompt, in a creator round.** Every contestant gets exactly this, with the brief's fields in place of the braces
([`lib/prompt.mjs`](lib/prompt.mjs)). The word target is round(seconds x 165 / 60): 83 words for 30 seconds, 165 for 60.

```text
Write a voiceover script for a {platform} video.

Creator: {creator}, a {niche} {kind}. Voice: {voice}.
Audience: {audience}.
Topic: {topic}
Length: about {seconds} seconds, roughly {words} spoken words.

Make it hold attention from the first second:
- Open with a hook in the first 3 seconds. No greeting, no intro, no "in this video".
- Short spoken sentences. Every line adds something new; never repeat a point.
- Deliver the payoff the hook promises, clearly, near the end. Then stop: no summary.
- Only state facts you are confident are true. Do not invent statistics, quotes or testimonials.
- Give short on-screen text (7 words or fewer) and a specific visual for each line.

Use exactly this format:
HOOK: <first spoken line>
HOOK TEXT: <on-screen text for the hook>
HOOK VISUAL: <what is on screen during the hook>
LINES:
1. SAY: <spoken line> | TEXT: <on-screen text, or none> | VISUAL: <what is on screen>
2. SAY: ... | TEXT: ... | VISUAL: ...
CLOSE: <last spoken line>
ALT HOOKS:
- <another hook>
- <another hook>
```

**Two kinds of round.** A creator round sends the long prompt above, filled from a creator brief. A plain round sends one line,
the way a person would ask, and nothing else: [`briefs/plain-2026-11-19.json`](briefs/plain-2026-11-19.json) holds the 16 pilot
topics as asks like "Make me a video about paying yourself first, 45 seconds long, for TikTok." Plain replies come in any
layout, so judges read each reply whole and the code checks do not apply: a plain round's scores are the judges' grades alone,
with the same rubric, strictness adjustment and truth cap.

**The briefs.** [`briefs/pilot-2026-10-18.json`](briefs/pilot-2026-10-18.json): 16 made-up creators and small businesses, 5 for
TikTok, 4 each for Reels and Shorts, 3 for Facebook Reels, from 30 to 60 seconds. Topics are everyday advice (saving, cooking,
renting, pets, home repair) so judges can check the facts. Two briefs state advice that depends on conditions the brief does not
give (P11, how often to water tomatoes; P16, how often to bathe a dog); judges grade each script against the brief as
written, so read those two briefs' truth grades with that in mind.

**The judges.** In a creator round each script is read into one plain layout; in a plain round judges read the reply whole and
are told to grade the video it proposes (its spoken lines, the first of which is the hook, its on-screen text and visuals), not
what the reply says about itself. Author names are withheld, though a reply's own format can hint at its maker. Each reply is
graded twice, with the criteria in two random orders kept in the pack's key and the score anchors reversed the second time. A judge must quote the script for every 1
or 2; a score whose quote is not in the script is dropped. From the next round a quote counts only as whole words, in order,
from the script's own text (never the layout's labels), and at least two words; the pilot used a looser match (see
[CHANGES.md](CHANGES.md)). A judge's grades count for a script only when both orderings were answered with a truth grade and at
least 12 of the 14 criteria. The judge's instructions and message are in [`lib/rubric.mjs`](lib/rubric.mjs).

**The rubric.** 14 criteria, each graded 0, 1 or 2 against written anchors.

| Hook | Script |
|---|---|
| H1 Topic clarity in the first line | S1 Brief fidelity |
| H2 Curiosity or stakes | S2 Novelty |
| H3 Relevance to the audience | S3 Progression |
| H4 Promise of what is coming | S4 Specificity |
| H5 Hook on mute | S5 Payoff |
| | S6 Ending and call to action |
| | S7 Sounds spoken |
| | S8 Edit readiness |
| | S9 Truth and safety |

**The checks code runs** ([`lib/shape.mjs`](lib/shape.mjs)):

| Check | Rule |
|---|---|
| D1 Length | 2 if spoken words are within 15% of the target, 1 if within 30%, else 0 |
| D2 Fast start | 0 if the hook opens with a greeting or filler; else 2 if the first sentence has 15 words or fewer, 1 if 20 or fewer |
| D3 Short sentences | 2 if the mean sentence is 14 words or fewer and none is over 25, 1 if the mean is 18 or fewer |
| D4 On-screen text | 2 if there is hook text and no text is over 7 words, 1 if there is hook text and none is over 10, else 0 |
| D5 Unsourced figures | percents, money or numbers over 10, written in digits, that the brief did not give: 2 if none, 1 if one, 0 if more |
| D4h Hook text | 2 if the hook text has 1 to 7 words, 1 if up to 10 |

**Scoring** ([`lib/score.mjs`](lib/score.mjs)):

- Only judges from another maker count toward a model's score, after removing each judge's strictness, estimated from every
  script two judges graded.
- Every judged criterion and every check below is taken as a share of its top grade (a 1 counts as 0.5, a 2 as 1).
- In a creator round: Hooks = 100 x (0.8 x the mean of H1 to H5 + 0.2 x the mean of D2 and D4h). Script = 100 x (0.8 x the judged script composite +
  0.2 x the mean of D1 to D5); the composite weights four groups: H1, H2, H3 and H5 35%; H4, S3 and S5 30%; S1, S2 and S4 20%; S6,
  S7 and S8 15%.
- If the judges' truth score (S9), after each judge's strictness is removed, is under 0.5 of 2, the script score is capped at
  40. (The pilot used the truth grades before that adjustment; `score --gate raw` reproduces it.) `results.json` also gives Index
  with no cap and with the other cap rule, under `sensitivity`, so a reader can see how much the cap moves the order.
- In a creator round: Facts = 100 x (0.8 x S9 + 0.2 x D5). Visual plan = 100 x (0.8 x the mean of H5 and S8 + 0.2 x D4), each
  term a share of its top grade.
- In a plain round replies come in any layout, so there are no code checks: Hooks = 100 x the mean of H1 to H5, Script = 100 x
  the judged composite, Facts = 100 x S9, Visual plan = 100 x the mean of H5 and S8. One reply per brief.
- In both: Index = (20 x Hooks + 25 x Script) / 45.
- Ranges are 95% bootstrap intervals over briefs, 2,000 resamples, each brief's scripts averaged first. A tier starts with the
  best model left; every model left whose range reaches that model's low end joins it. Each model's difference from the leader
  is also given on matched briefs, with a paired 95% range, which says more than the tiers.

## Run it yourself

Node 18 or newer, no dependencies. Keys come from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `GEMINI_API_KEY`; only the makers you
run need one. Copy [`rates.example.json`](rates.example.json) to `rates.json` and fill in each model's price per million tokens
from its maker's price page on the day you run (prices change, so none ship here).

```sh
git clone https://github.com/viewgum/short-form-script-benchmark && cd short-form-script-benchmark

# See exactly what a model gets
node bin/bench.mjs prompts --briefs briefs/pilot-2026-10-18.json --brief P01

# Write the scripts. It stops before any call whose worst case could take the run past --max-usd, counts a failed call at its
# worst case unless the vendor refused it outright, and a rerun resumes. A run folder keeps its settings in manifest.json; a
# resume may add contestants or run a subset, and is refused if the briefs, prompts or a contestant's model id changed.
node bin/bench.mjs generate --briefs briefs/pilot-2026-10-18.json --contestants claude-haiku-5-5,gemini-4-neon \
  --run runs/my-run --samples 2 --rates rates.json --max-usd 5

# One folder of judge prompts per judge, for the scripts of other makers only (--all-makers adds its own maker's), with
# random names that say nothing about the author; the key is in judging-keys/. Answer each prompt and save the answer next to
# it, same name, ending .reply.txt
node bin/bench.mjs judge-pack --briefs briefs/pilot-2026-10-18.json --run runs/my-run --judge judge-openai
node bin/bench.mjs judge-pack --briefs briefs/pilot-2026-10-18.json --run runs/my-run --judge judge-anthropic

# Score: checks, judges from other makers only, ranges and tiers; writes runs/my-run/results.json
node bin/bench.mjs score --briefs briefs/pilot-2026-10-18.json --run runs/my-run
```

A judge can answer through its API (run `judge-pack --judge gpt-6.2-astra` first, then `node bin/bench.mjs judge --run
runs/my-run --judge gpt-6.2-astra --rates rates.json --max-usd 5`) or through an agent CLI you already use, one loop per judge
folder. With Codex, for the OpenAI judge:

```sh
for f in runs/my-run/judging/judge-openai/*.prompt.txt; do
  r="${f%.prompt.txt}.reply.txt"; [ -f "$r" ] && continue
  codex exec -m gpt-6.2-astra --skip-git-repo-check --ephemeral -s read-only -o "$r" - < "$f"
done
```

With Claude Code, for the Anthropic judge:

```sh
for f in runs/my-run/judging/judge-anthropic/*.prompt.txt; do
  r="${f%.prompt.txt}.reply.txt"; [ -f "$r" ] && continue
  claude -p --model claude-opus-5-5 < "$f" > "$r"
done
```

Say which way each judge ran when you publish: an agent CLI adds its own instructions, so its grades are not the same as the
bare API's.

`node test.mjs` checks that the prompt, rubric, checks and scoring lines match the published method
([`method/published-method.json`](method/published-method.json), from the 2026-10-18 pilot) word for word, and
tests the parser, the checks, the quote rule, the strictness offsets, the spending cap, the run lock and manifest, and a full
score and render on a small run. `node scripts/render-scripts.mjs runs/my-run` writes one readable page per brief.

## Adding a model or a round

Add the model to [`models.json`](models.json) with its maker and the API that serves it, run the commands above, and open a pull
request with the run folder's `manifest.json`, `ledger.jsonl`, `outputs/`, `judging/`, `judging-keys/` and `results.json`, and say
how each judge ran. The prompt, rubric and scoring are fixed; any change
goes in [CHANGES.md](CHANGES.md) with its date before the data it affects is scored.

## Disclosure

The benchmark is run by ViewGum, which makes a short-form video app. ViewGum's own app is not a contestant and nobody pays for
placement. Model names are the makers' own product names, used only to say which model was asked; no maker endorses or is
affiliated with this benchmark. Gemini is a trademark of Google LLC.

## License

Code: MIT ([LICENSE](LICENSE)). Data (`briefs/`, `method/`, `models.json`): CC BY 4.0, credit "ViewGum, viewgum.com"
([briefs/LICENSE](briefs/LICENSE)).

## Maintainer

Maintained by [ViewGum](https://viewgum.com).
