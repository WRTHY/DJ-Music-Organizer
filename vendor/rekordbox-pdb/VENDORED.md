# Vendored: rekordbox-pdb

This directory is a vendored, pinned copy of a third-party library — not
code written for this project. Everything under `src/`, `tests/`, `LICENSE`,
`README.md`, `FORMAT.md`, and `pyproject.toml` is reproduced as-is from
upstream, unmodified.

**Upstream**: https://github.com/fragmede/rekordbox-pdb
**Pinned commit**: `ee3bac2f22ca11a5ce61eea35f8cb951c246eaef` (2026-07-05)
**Vendored**: 2026-09-15
**License**: MIT (see `LICENSE` in this directory — copyright fragmede)

## Why this is here

See `docs/decisions.md`, 2026-09-15 entry ("Phase 5 task #22 resolved") for
the full reasoning. In short: this project's Rekordbox write side needs to
append rows to a real `export.pdb`'s existing page/table chains — the same
"surgical, incremental changes rather than rewriting the file" strategy
Rekordbox itself uses — and this library already implements exactly that,
correctly, with a passing test suite and no dependencies. Rather than
reverse-engineer the same row/page-allocation mechanics ourselves with no
CDJ hardware available to validate a first-party writer against, this
project wraps `PdbEditor` (`src/rekordbox_pdb/edit.py`) as the actual write
mechanism from a thin Node-side adapter (see `packages/core`), while
diffing, orchestration, and read-back verification stay this project's own
TypeScript code.

This library is also already this project's independent read-oracle
(decision 23) — the same codebase, now trusted for both directions.

## Verified before vendoring (this session, 2026-09-15)

- Read the source in full (`pdb.py`, 617 lines; `edit.py`, 502 lines) —
  the append logic matches its own module-doc description: per-row heap
  allocation, the row directory growing down from the page end,
  presence/written bitmasks, the >255-slot count encoding, fresh-page
  allocation when a page fills, and a per-table write-generation stamp
  plus file-header sequence bump on every structural change.
- Its own test suite: `PYTHONPATH=src python3 -m pytest` from this
  directory — **44 passed, 6 skipped** (the skipped ones need larger local
  captures / a Kaitai differential fixture not present in this checkout;
  they skip gracefully, per its own README).
- Read James's real, hardware-burned reference USB
  (`F:\PIONEER\rekordbox\export.pdb`, read-only, never modified) with
  `Database.from_file`: 3,549 tracks, 431 playlist/folder nodes, 4,037
  playlist entries — an exact match to this project's own reader's counts
  for the same drive (decision 21/23).
- Appended a test track + playlist + playlist entry to a **scratch copy**
  of that same file with `PdbEditor` (the real `F:\` drive was never
  written to), then re-read the result: the new track/playlist/entry are
  present and correct, all 3,549 original tracks are unchanged, and a
  byte-level diff against the pre-edit copy shows only **355 of
  2,408,448 bytes changed (0.015%)** — direct, real-data proof that this
  is genuinely a surgical edit, not a rewrite.

## Updating this vendored copy

Don't edit these files in place. To pull in an upstream update: re-clone
at the new commit, re-run its test suite in a scratch checkout, re-run the
same real-USB read/write smoke test above, update the pinned commit hash
and date in this file, then replace this directory's contents wholesale
and note the change in `docs/decisions.md`.
