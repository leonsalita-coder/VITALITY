# Coverage queue — survivors, module by module

Each module was swept with `node scripts/mutate.mjs --mode=mutate --files=<module>`,
every survivor read, and **tests** added (no engine code changed). A survivor
left standing has one of two things here: a proven equivalence, or a written
reason it is a gap nobody should close by pinning the implementation.

"Proven equivalent" means run, not argued: the original and mutated module
were bundled side by side and the same generated inputs pushed through both,
including through the real downstream consumer. The tool that does this is
described at the end.

The two-a-day `.fails` tests in `tests/train/two-a-day.test.ts` are left
failing on purpose throughout; they wait on decisions that are not the
harness's to make.

---

## predictions — 20 → 3

**Real gaps closed (17):** metres scoring was untested outright (hit, short,
and the 20%-too-light edge); the seconds too-light edge; `recordPrediction`
refusing a missing id / missing date / null store / null prediction, each on
its own; `accuracyOver`'s `since` filter and its inclusive boundary (the tile
uses it); `whenWrong` staying null when nothing was wrong; and the three
`progressionDamping` edges — exactly the sample gate (10 is enough), exactly
a 60% rate (not poor: the rate is the one *below which* it eases off), and
exactly 60% of misses high (qualifies) — plus a decent record with all-high
misses, which must stop at the rate gate before direction is considered.

**Left (3):**

- `L170` sort `||` → `&&` — **equivalent, proven.** It changes only the
  insertion order of the `byBasis`/`byLift` keys. Nothing reads them: not
  the tile, not any engine module (grepped). Across 400 generated stores ×
  three `since` values, the values (keys sorted), `progressionDamping` and
  the tile's accuracy line (`train.html:7672`, reproduced verbatim) were
  identical; only the raw key order differed.
- `L171` empty-store early return removed — **equivalent, proven.** The loop
  then builds a deep-equal empty result. Same 1,602 comparisons, 0 differ,
  including empty, null, and fully-filtered-by-`since` stores.
  *Side note, not a test gap:* the early return hands back `{ ...EMPTY }`,
  whose `byBasis`/`byLift` are the SAME objects on every empty call. A
  caller that mutated them would poison every later empty result. Nothing
  does today.
- `L204` `missedHigh >= missedLow` → `>` — **a real, unspecified choice; not
  pinned.** On a tie the text says "usually too high (1 of 2)" — "usually" is
  false at 50/50, and the tie-break direction is arbitrary. A test pinning
  either side would assert the implementation, not a rule. Needs a decision
  (e.g. "as often too high as too light"). It never reaches damping: damping
  requires ≥ 60% of misses high.

Fixture shape: nothing here was masked by shape rather than value.
