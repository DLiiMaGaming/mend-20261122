# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/DLiiMaGaming/mend-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/DLiiMaGaming/mend-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files — in any of
the four formats models actually write — and changes every file or none at all.

    node main.ts [options] [PATCH]

- **Unified diffs** (`--format=unified`): hunks apply by content, not by the line
  numbers the model wrote — a hunk lands on the occurrence nearest its (possibly
  wrong) `@@` line, and drifted whitespace or indentation is matched at three
  tiers (exact, trailing whitespace, both sides).
- **SEARCH/REPLACE blocks** (`--format=search-replace`): the old lines must occur
  exactly once at their tier, or the block fails as ambiguous.
- **V4A patches** (`--format=v4a`): `*** Add File`, `*** Delete File`,
  `*** Update File` (with `*** Move to:` and `@@` anchors), chunks applied in
  order behind a cursor.
- **JSON tool calls** (`--format=json`): `create`, `str_replace` and `insert`,
  as one array or as JSON Lines.

`--check` reports what would change without writing anything; `--strict`
matches lines exactly (tier 0 only). See [SPEC.md](SPEC.md) for the whole
contract. Node 22, standard library alone, no install step.

## Practice score

    node check.ts ../program/generator/practice.json

100 of the 100 public practice checks pass (practice score 1000) on the kit's
`program/generator/practice.json`, run the way the grader runs them.

## Entry

Built for the make.fun competition
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
— "Build mend, one patch tool for every AI edit format".
