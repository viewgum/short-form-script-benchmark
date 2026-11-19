# Changes to the method

The prompt, briefs, rubric, checks and scoring are fixed before any round is scored. A change is listed here with its date before
the data it affects is scored.

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
- 2026-11-19: plain rounds added (`briefs/plain-2026-11-19.json`): one line per topic, the way a person asks, with no brief or
  format. Judges read the reply whole; scores are the judged part of each formula alone, since replies in any layout have no
  code checks.
- 2026-11-19, after an independent review of the first plain round, before it was published (that round was judged again):
  - Plain-round judges are told to grade the video the reply proposes (its first spoken line is the hook), not what the reply
    says about itself or whether it can make a video file.
  - The truth cap reads the truth grade after each judge's strictness is removed, so a lenient judge on a panel cannot shield a
    reply; `score --gate raw` keeps the pilot's rule.
  - Tiers compare every model left with that tier's leader, not only the model before it; paired differences from the leader on
    matched briefs are reported.
  - Each pack key stores a random criterion order; score counts missing judge replies and refuses a key without a prompt hash.
  - Typed refusals and blocked replies are kept as answers; a reply that reports only part of its usage counts at its worst case.
