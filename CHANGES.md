# Changes to the method

The prompt, briefs, rubric, checks and scoring are fixed before a round is scored, and a change is listed here with its date.
One exception: the plain round of 2026-11-19 was scored, reviewed before publication, and judged again twice under the
amendments below. Its published results are a reanalysis of the same 160 replies under the amended method; the earlier
scores are not published. The rubric and scoring lines as amended are in `method/amendments.json`.

- 2026-10-18: pilot run on the 16 briefs in `briefs/pilot-2026-10-18.json`; judges Claude Sonnet 5.5 and GPT-6.1 Sol.
- 2026-11-19: method published in this repo unchanged from the pilot; the creator names and voices of the 16 briefs published for
  the first time, so anyone can rerun them.
- 2026-11-19: amendments that apply from the next round; the pilot's published numbers were computed before them and stand as
  published.
  - A judge's quote counts only as whole words, in order, from the script's own text (not the layout's labels), and at least
    two words unless it is a whole field. The pilot matched quotes as text anywhere in the judge's layout.
  - A judge's grades count for a script only with both orderings answered, a truth grade and at least 12 of 14 criteria. Every
    pilot grade met this.
  - The unsourced-figures check (D5) compares a figure with the brief's in the same form: a brief's "36 hours" covers 36, not $36
    or 36%. Figures written in words are still not read.
  - A line's TEXT and VISUAL are read from their own pipe-separated parts, so a spoken "text:" is not taken as on-screen text.
  - A judge pack holds only other makers' scripts by default, under random names, with the hash of each prompt kept beside its
    key so a changed script or rubric is refused. Each ordering must stand on its own (a truth grade and 12 criteria).
  - The runner writes every call to its ledger as pending, at its worst case, before sending it.
- 2026-11-19: briefs P11 (tomato watering) and P16 (dog bathing) state advice that depends on conditions the brief does not give.
  They stay unchanged in the next round so its results compare with the pilot's; judges grade against the brief as written.
- 2026-11-19: plain rounds added (`briefs/plain-2026-11-19.json`): one line per topic written for the round, with no brief or
  format. Judges read the reply whole; scores are the judged part of each formula alone, since replies in any layout have no
  code checks.
- 2026-11-19, after an independent review of the first plain round, before it was published (that round was judged again):
  - Plain-round judges are told to grade the video the reply proposes (its first spoken line is the hook), not what the reply
    says about itself or whether it can make a video file.
  - The truth cap reads the truth grade after each judge's strictness is removed, which takes out a judge's average leniency;
    a judge that gives nearly every reply the top truth grade still makes the cap hard to reach for the replies it grades.
    `score --gate raw` keeps the pilot's rule.
  - Tiers compare every model left with that tier's leader, not only the model before it; paired differences from the leader on
    matched briefs are reported.
  - Each pack key stores a random criterion order; score counts missing judge replies and refuses a key without a prompt hash.
  - Typed refusals and blocked replies are kept as answers; a reply that reports only part of its usage counts at its worst case.
- 2026-11-19, after a second review of the plain round, before it was published (judged again):
  - H1 grades the first spoken sentence, in its name and all three anchors (it said "first line" in one place and "first
    sentence" in another).
  - H5 counts opening text on screen as an overlay or as readable words on a prop or sign the script shows.
  - Plain-round truth covers everything a viewer would hear, see or read, including a caption or post text written for
    publishing; notes meant only for the editor do not count.
  - Tiers are reported only in `results.json`; the READMEs give ranges and paired differences from the leader, labelled
    exploratory. `results.json` adds Index without H5 to its sensitivity block.
  - Score counts a judge as expected when it has keys, even if its reply folder is gone; `attempts.jsonl` keeps started and
    finished rows; a saved refusal is never asked again on resume; a Gemini reply without its own token count counts at its
    worst case.
