# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/piagiosuper007-gif/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/piagiosuper007-gif/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats, and mend reads them all: unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. Every file is changed or nothing is.

Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty, $100 in USDC.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or `-` / absent to read the patch from standard input. The working directory is the root of the tree; every path in a patch is relative to it.

Options:

- `--format=NAME` — read the patch in one format: `unified`, `search-replace`, `v4a`, `json`; `auto` (the default) detects it.
- `--check` — do everything but write: same output and exit code, no file created, changed or deleted.
- `--strict` — match lines exactly (tier 0 only).

Exit codes: `0` with one line per changed path plus `ok: <n> files`; `1` with one `error: <code> <path>` line per failed edit plus `failed: <k> of <n> edits` (a failed edit changes nothing, later edits still run, and when any edit failed no file is written); `2` with exactly one line for usage, unreadable-patch, undetected-format and parse errors.

## How it works

- **Three-tier matching.** Old lines are found at the first tier where they occur: exact, then ignoring trailing spaces/tabs, then ignoring leading and trailing spaces/tabs. At tier 2, new lines are re-indented from the old lines' leading whitespace to the file's, and context lines are always written as the file's own matched lines. `--strict` tries tier 0 only.
- **Unified diffs.** Sections from `diff --git` or `---`/`+++` headers (including `rename from`/`to`, `new file mode`, `deleted file mode`); hunks take the occurrence nearest to their stated line, adjusted for earlier hunks; empty hunks insert; `\ No newline at end of file` controls the final line break; creations, deletions and moves are one edit each.
- **SEARCH/REPLACE.** The path is the nearest non-blank, non-fence line before the block (or the previous block's path); empty old lines create the file; otherwise the old lines must occur exactly once at their tier.
- **V4A.** `*** Add/Delete/Update File` sections; update chunks find their anchor, then the first occurrence at or after the cursor, with `*** End of File` anchoring a chunk to the end of the file and `*** Move to:` moving the result.
- **JSON.** One array or JSON Lines of `create` / `str_replace` / `insert` edits, with exact matching and CRLF preserved.
- **Safety and atomicity.** Every named path is checked for safety before anything else; edits apply in order to the tree as earlier edits left it; any failure rolls the whole patch back.

Node 22, standard library only. The full contract is in `SPEC.md`; `check.ts` runs the practice set (`node check.ts <practice.json>`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=f68xw5ge&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
