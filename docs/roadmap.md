# Roadmap

Long-term implementation plan: phases, concrete deliverables, and the
testing that has to happen at each stage before the next one is trusted.
This complements `decisions.md` (why choices were made) and
`design-system.md` (UI conventions) — this file is about *what's next and
in what order*, and gets updated as phases complete or the plan changes.

## How the phases are ordered

Everything downstream of "read Serato's crates" is safe by construction —
it can't corrupt anything real. Everything from the crate **writer**
onward touches, or could eventually touch, 5 years of irreplaceable
library data, so the phases are ordered by risk, not just by feature
value: prove something in isolation (scratch data, synthetic fixtures,
spare hardware) before it's ever allowed near James's real
`E:\_Serato_`. No phase that writes to real Serato data starts before the
phase before it has a passing, repeated round-trip test suite.

## Phase 0 — Foundation (done)

- Canonical tree data model, tool-agnostic.
- Serato folder-tree reader + crate-database reader, validated against a
  real library.
- Copy-first organizer: plan/execute split, dry-run, content-hash conflict
  detection.
- Electron app: main/preload/renderer, shared IPC contract, native folder
  picker, per-action loading states, design system.
- 19 automated tests (core + IPC handlers).

## Phase 1 — Ship v1: a trustworthy one-way library builder

**Goal**: prove the full pipeline end-to-end on real hardware and real
data (not just the cloud-sandbox smoke test), and package something you
could actually hand to a friend.

Deliverables:
- A real installer (`npm run dist:desktop`, `electron-builder`), installed
  and run on your own machine.
- A full scan → plan → dry-run → execute pass against your actual
  `E:\_Serato_` library end to end.
- Progress reporting for large scans. Right now a scan either finishes or
  it doesn't — there's no feedback while it's running. IPC today is
  request/response only (`invoke`/`handle`), so a long scan just looks
  frozen. Fixing this means main process pushes progress events to the
  renderer as it walks the tree (`webContents.send`), which is a new IPC
  pattern beyond what's built so far — worth doing before this goes in
  front of anyone but you, since 5 years of music is not a small scan.

Testing:
- **Unit** (expand `core`): unicode filenames, deeply nested crates, empty
  crates, duplicate filenames in different folders, Windows' 260-character
  path limit (a real risk with deeply nested crate hierarchies).
- **Integration** (expand IPC handler tests): error paths — missing
  folder, permission denied, disk full mid-copy.
- **E2E**: first real Playwright `_electron` test(s), driving the actual
  UI against a checked-in synthetic `_Serato_` fixture (not your real
  library — this needs to run unattended in CI).
- **Manual/exploratory**: a written test charter, run by hand against your
  real library once it's installer-packaged — this is the one place
  automated coverage can't stand in for actually using it.
- **Non-functional**: measure real scan time against your full library;
  confirm the UI doesn't lock up.
- **Data-safety regression**: dry-run's reported plan must match what
  execute actually does, exactly; re-running execute against an
  already-organized target must not duplicate files.

## Phase 2 — Crate writer, proven in isolation (core deliverable done; trust gate still open)

**Goal**: build the write half of the Serato format — the highest-risk
piece of engineering in this whole project — and don't let it near
anything real until it's been proven wrong a lot of times in a sandbox.

Deliverables:
- **Done**: `packages/core/src/serato/crateDatabaseWriter.ts`, the mirror
  of the already-validated reader — same chunk format, same encoding,
  same path convention. One `.crate` file per canonical-tree node that
  has direct tracks; guards against a folder name containing `%%`, a
  track outside the given volume root, and root-level tracks (returned as
  `skippedRootTracks` rather than silently dropped).
- **Done**: a round-trip test suite (`__tests__/crateDatabaseWriter.test.ts`,
  4 tests): canonical tree → write → read back with the trusted reader →
  deep-equal diff. Covers nested crates, the `%%` hierarchy, unicode
  names, an empty intermediate folder, one track in two crates — every
  track resolves to a real placeholder file, so `unresolvedCount` coming
  back `0` is a genuine end-to-end proof, not just structural. All
  passing; full `core` suite is 34 tests, green.
- **Done**: property-based round-trip testing (`fast-check`,
  `__tests__/crateDatabaseWriter.property.test.ts`) — many random
  two-level tree shapes, not just hand-picked fixtures, all round-tripping
  correctly. It earned its setup cost immediately: it surfaced a real
  round-trip limitation (a fully-empty subtree writes no file and so
  doesn't survive a round trip — not a bug, but a real property of the
  format worth knowing before Phase 3's incremental-diff logic gets
  built), now documented directly in `crateDatabaseWriter.ts`.
- **Still open, and the actual trust gate — blocked on hardware, not on
  more building**: one manual checkpoint that can't be automated — write
  to a **scratch** flash drive (never `E:\_Serato_`), open the result in
  real Serato, confirm by eye that it matches. James doesn't have a spare
  USB on hand right now; this is deferred, not skipped. Nothing in Phase
  3 or 4 should be trusted against this writer until that checkpoint has
  happened at least once.

## Phase 3 — Burn to flash (software side done and verified; trust gate still open)

**Goal**: the feature that actually delivers "plug and play on any Serato
rig" — take the canonical library and write a fresh, complete `_Serato_`
structure onto a target drive, without re-copying everything that's
already there.

**Design decided (2026-09-09, see `docs/decisions.md`)**: content-hash
identity is added as a new, separate concept looked up on demand — not a
field the existing readers populate on every scan, since that would make
ordinary scanning slower for no benefit outside this phase. A computed
hash is cached in a small JSON-backed index (path → size/mtime/hash),
trusted only while size and mtime still match, so re-scanning the library
doesn't mean re-hashing every file every time. Diffing against a
destination is additive-only: a file at the destination with no matching
source track is left alone, never deleted — consistent with this
project's "prove it before it's allowed to be destructive" posture.
Deleting orphaned files is explicitly out of scope for this phase.

Deliverables, in build order:
1. **Done** — `packages/core/src/trackIndex/`: `TrackIndexStore`
   interface (`get`/`set`/`all`/`load`/`save`) plus a `JsonTrackIndexStore`
   implementation, and `hashWithCache(store, absolutePath)` (stat → reuse
   cached hash if size+mtime match, else recompute and update the
   cache). `core` code depends only on the interface, so a different
   storage backend can slot in later without touching planner/executor.
   11 tests.
2. **Done** — `packages/core/src/organizer/diff.ts`: `diffAgainstDestination`
   compares the canonical source tree against what `readFolderTree` finds
   already at a destination (a burn target, or the ordinary
   copy-to-canonical-tree target — the same logic covers both, per the
   note below), classifying each source track `new` / `unchanged` /
   `changed` by content hash; `planFromDiff` turns that into a plan with
   only `new`/`changed` items; `summarizeDiff` gives preview counts. 7
   tests, including a real end-to-end proof that burning/copying twice
   in a row to the same destination copies nothing the second time.
   **Along the way, found and fixed a real gap in `executor.ts`**: on a
   genuine content mismatch it always renamed the new file aside
   ("track1 (2).mp3") rather than updating in place — correct for an
   accidental collision between unrelated tracks, but wrong for a
   diff-confirmed update, where it would otherwise pile up an
   ever-growing set of duplicates every re-burn. Fixed with a new
   `ExecuteOptions.allowOverwrite` flag (default off, so the plain ad hoc
   copy flow is unchanged) that diff-driven execution passes explicitly.
   See `docs/decisions.md` for the full write-up.
3. **Done** — `packages/core/src/serato/burnToFlash.ts`: diff → plan
   (copy only what changed, `allowOverwrite: true`) → execute →
   `writeCrateDatabase` (Phase 2) to regenerate the *entire* crate
   structure at the target → a verification pass that reads the result
   back with the real reader and compares track placement against what
   was expected
   (`ok`/`unresolvedCount`/`missingTrackIds`/`unexpectedTrackIds`/`misplacedTrackIds`).
   Along the way, found and closed a real bug-in-waiting: crate
   generation needs every track's *destination* path, not just the ones
   copied this run, or an `unchanged` track would silently disappear from
   the regenerated crates despite its audio file being untouched and
   fine on disk — fixed via `treeAtDestination` in `organizer/diff.ts`,
   built from the full diff. 6 tests, including that exact
   add-one-track-without-losing-the-others case. See `docs/decisions.md`.
   **Verification strengthened 2026-09-10**: the original comparison was
   a flat, library-wide set of track ids, which couldn't tell a track
   apart from that same track silently reassigned to a *different*
   crate — exactly James's "burn looked fine, folder was missing at the
   club" fear. `diffTrackPlacement` now compares per-crate-path and adds
   `misplacedTrackIds` to catch that case specifically; 5 new tests
   including the swapped-crates scenario. Full write-up, including the
   honest limits of self-verification and further options discussed but
   not yet built, in `docs/decisions.md`.
   Still gated on Phase 2's still-open manual hardware checkpoint before
   this is trusted against a real target.
4. **Done** — a "Burn to flash" card in the desktop app: pick a target
   drive/folder → "Preview burn" (counts of new / changed / unchanged,
   no "will delete" warning needed since this is additive-only) →
   "Burn" → verification result shown, with a plain warning (not a
   crash) if `verification.ok` comes back false. New
   `IPC_CHANNELS.diffBurn`/`.burn` channels, a `BurnArgs` contract shared
   by both, and the content-hash cache now has a real home
   (`app.getPath('userData')/track-index.json`). Burning respects the
   same SelectionTree checkboxes the copy flow already has. Built while
   this session's bridge shell to James's machine was down (see
   `docs/decisions.md`'s 2026-09-10 entry) and verified afterward --
   `npm run typecheck` and `npm test` both pass.

**Update, 2026-09-11 — the manual hardware checkpoint happened, and it
found a real gap.** The diff/plan/execute/verify pipeline itself is
proven against real hardware: a real burn to `D:\TRIAL_BURN` copied
330/335 tracks correctly, and the 5 that failed traced to unrelated,
pre-existing stale metadata in Serato's own crate data (see
`docs/decisions.md`), not this pipeline. But opening that drive in real
Serato showed nothing — `.crate` files reference tracks by pointing
into Serato's master `database V2` index, which this project has never
written, so a track this project burns is invisible to Serato's UI
until something (Serato itself, manually, today) tells `database V2`
about it. **"Phase 3's software side is now fully built and verified"
was premature** — the diff/burn/verify mechanics are solid, but
"Serato recognizes a freshly burned drive" — the goal stated at the top
of this phase — needs a `database V2` writer that doesn't exist yet.
Full write-up, including why this isn't the same risk as Phase 4's
live-database gate, in `docs/decisions.md`.

**Generalizes beyond burn-to-flash** (James, 2026-09-08): the diff step
above already applies equally to the ordinary copy-to-canonical-tree
step, not just a flash-drive target — the same `diffAgainstDestination`/
`planFromDiff` pair works for either destination.

Testing:
- **Done**: index-store unit tests (cache hit/miss, atomic-save,
  corrupted-file recovery); diff-classification unit tests against real
  files (new/unchanged/changed, mixed across nested folders);
  integration test proving a second diff+execute pass copies nothing;
  a third-pass test proving only a genuinely-changed track gets
  re-copied (and overwritten in place, not renamed aside).
- **Done**: burn-orchestrator unit tests (first burn from empty, a
  second burn with no source changes proving the crate database still
  references every track, adding a track between burns, a changed track
  overwritten in place rather than renamed aside, source-tree
  immutability, nested crate hierarchies).
- **Done, 2026-09-11**: real hardware test — burned to `D:\TRIAL_BURN`
  (330/335 copied, 5 traced to pre-existing stale Serato metadata
  unrelated to this pipeline — see `docs/decisions.md`). Folder
  structure and track contents confirmed correct by James, by hand, in
  real Serato, after manually adding the drive so Serato would
  recognize it — which is exactly what exposed the `database V2` gap
  below. Second-rig confirmation still open, otherwise done.
- **Still open**: failure injection — drive unplugged mid-burn, drive
  fills up mid-copy — must fail safely, never leave a half-written crate
  database behind.
- **Superseded by Phase 3b below**: the `database V2` writer gap found
  2026-09-11 — see that phase for the actual scope.

## Phase 3b — `database V2` writer (new, scoped 2026-09-11)

**Goal**: a freshly burned drive shows up in Serato on its own — no
manual "add this folder" step required. This is what actually finishes
Phase 3's original promise ("plug and play on any Serato rig"); without
it, `.crate` files reference tracks Serato's own index has never heard
of and nothing renders (full diagnosis in `docs/decisions.md`,
2026-09-11 entry).

**Explicitly separate from Phase 4, not a subset of it.** Phase 4 is
about safely *editing* James's existing, in-daily-use `database V2` —
real risk to something he depends on every session, hence the mandatory
backup gate. This phase only ever *creates* a `database V2` from
nothing, on a blank scratch drive that never had one — closer in kind
to what Serato itself does the first time it meets new media. The two
should stay gated at different risk tiers; conflating them would block
this lower-risk work behind a gate that isn't actually about it.

**Explicitly out of scope for this phase**: writing into a drive that
*already has* a `database V2` from a previous burn or from prior Serato
use. That's a merge problem — reconcile what's already there with
what's new without clobbering anything Serato itself wrote in the
meantime (extra crates, cue points, play counts) — and it's a
meaningfully harder and riskier problem than "write one from scratch."
It's the natural next step after this phase, but it doesn't block it:
a from-scratch writer already covers the actual `TRIAL_BURN` use case
(a blank drive) and is where the format-research risk gets retired
first, in the lowest-risk setting available, same as Phase 2 did for
crates.

Deliverables, in build order:
1. **Research — done, 2026-09-11.** `database V2` turned out to use the
   exact same outer chunk framing as `.crate` files, confirmed by
   walking James's real file
   (`E:\LIBRARY BACKUP 9_10_2026\_Serato_\database V2`, ~8 MB, 11,991
   tracks) byte-by-byte rather than trusting a write-up — full findings
   and the complete field-tag table are in the new
   `docs/serato-database-v2-format.md`; the investigation itself is in
   `docs/decisions.md`'s 2026-09-11 entry. Every open question below is
   answered there:
   - Same outer chunk framing as `.crate` files (4-byte tag + 4-byte
     big-endian length)? **Yes, confirmed identical.**
   - What fields are actually *required*? **Not provable without a live
     Serato write/reload test (that's Deliverable 5's job, not this
     one)**, but Serato's own "rebuilding the database" support article
     implies a from-scratch writer likely only needs `pfil` (and
     probably `ttyp`) right, trusting Serato's own scan to backfill the
     rest.
   - Does `database V2` encode crate membership? **No — confirmed both
     by the byte walk and by an independent secondary source.** The
     `serato-crate-format.md` assumption stands.
   - Per-track analysis data (waveform, cues, beatgrid) — in the audio
     file's ID3 tags, or in `database V2`? **Confirmed: the file's own
     ID3 GEOB tags** (pulled real ID3 frames off a sampled track and
     found `Serato Overview`/`Analysis`/`Autotags`/`Markers_`/
     `Markers2`/`BeatGrid`/`Offsets_` GEOB frames; none of that data is
     in `database V2`). The existing `fs.copyFile`-based copy already
     carries it over for free — confirmed, not just assumed now.
   - Any checksum/integrity field? **None found** — the byte walk
     leaves nothing unaccounted for.
2. **Reader — done, 2026-09-11**
   (`packages/core/src/serato/databaseV2Reader.ts`): proved the format
   is understood before writing anything — mirrors how
   `crateDatabaseReader.ts` came before `crateDatabaseWriter.ts`.
   Tested against synthetic buffers and a byte-for-byte reproduction of
   the real confirmed layout (`__tests__/databaseV2Reader.test.ts`, 5
   tests, passing alongside the full existing 92-test suite), then run
   directly against the real file: parsed all 11,991 tracks cleanly,
   matched the version string. Serato's own `bmis`/`bcrt` flags mark 308
   tracks missing-at-last-scan and 35 corrupt — **not yet cross-checked
   against what Serato's own UI shows for this library**, which is the
   quick, real confirmation still worth doing before leaning on this
   reader further (a live look at the "All..." crate's counts).
3. **Writer, blank-drive case only — done, 2026-09-12**
   (`packages/core/src/serato/databaseV2Writer.ts`): given a
   `CanonicalTree`, writes a `database V2` from nothing — no existing
   file to merge against; refuses outright if one already exists at the
   target rather than merging or guessing. Field set per track is
   deliberately minimal (`pfil` + `ttyp` only — see Deliverable 1's
   "required vs. displayed" finding above). Two properties this format
   requires that the crate writer doesn't: every unique track gets
   exactly one entry regardless of how many crates reference it
   (deduplicated by track id — proven with a property-based test, not
   just hand-picked cases), and root-level (uncrated) tracks are
   included rather than skipped, since `database V2` has no concept of
   crate placement at all. Round-trip tested the same way
   `crateDatabaseWriter.ts` was: write → read back with the Deliverable
   2 reader → diff (`databaseV2Writer.test.ts`, 5 cases) + property-based
   testing for the dedup property specifically
   (`databaseV2Writer.property.test.ts`, 40 runs).
4. **Wire into `burnToFlash.ts` — done, 2026-09-12**: alongside the
   existing `writeCrateDatabase` call, a burn now also writes a fresh
   `database V2` when the target's `_Serato_` folder doesn't already
   have one. The existing-file check happens in `burnToFlash.ts` itself
   (`writeDatabaseV2IfBlank`), ahead of calling the writer, so a burn to
   a volume that already has a real `database V2` reports a normal,
   expected outcome on the report (`databaseV2: { written: false,
   reason: 'already-exists' }`) instead of the writer's own
   defense-in-depth throw aborting an otherwise-successful burn.
   Deliberately kept out of `BurnVerification`'s `ok` flag — that's
   Phase 3's already-established trust gate, and this phase has its own
   later one (Deliverable 5), so the two stay separate rather than
   conflated. `core` suite: 99 tests (up from 92), clean. Full write-up
   in `docs/decisions.md`, 2026-09-12 entry.
5. **Trust gate, same pattern as Phase 2/3 — done, 2026-09-14 (partially:
   see Deliverable 6).** Burned a genuinely blank drive and confirmed
   Serato shows the full folder/crate structure on a second machine with
   **no** manual "add folder" step — the core hypothesis this whole phase
   exists to test. **But** the same test surfaced a real regression this
   phase hadn't anticipated: Serato wanted to re-analyze all ~15,000
   tracks on the burned drive. Full diagnosis and fix in Deliverable 6.
6. **Fix: preserve analysis state across a burn — done, 2026-09-14 (new
   deliverable, added after Deliverable 5's hardware result).** Diagnosed
   and confirmed (full detail in `docs/decisions.md`, 2026-09-14 entry):
   the minimal `pfil`+`ttyp` field set from Deliverable 3, while
   sufficient for a track to *show up*, is not sufficient to stop Serato
   re-analyzing it — proven directly via a `DBV2-legacy.zip` Serato wrote
   on James's own re-tested trial-burn drive, an automatic backup of
   exactly this project's minimal output, replaced by Serato's own
   106 KB rewrite adding 17 fields present on every rescanned track.
   Fix: `databaseV2Writer.ts`'s new `sourceRecords` option carries a
   track's *entire* original record forward byte-for-byte (only `pfil`
   rewritten) when one is available from an already-analyzed
   `database V2`, via new raw-record read functions in
   `databaseV2Reader.ts` and a `sourceDatabaseV2` option threaded through
   `burnToFlash.ts`. `core` suite: 108 tests (up from 99), clean
   typecheck, plus a direct smoke test against James's real, live
   11,991-track `database V2`.
   **Resolved by Deliverable 7 below**: which file to pass as
   `sourceDatabaseV2` for a real burn, and the desktop UI wiring itself.
7. **UI wiring — done, 2026-09-14** (`docs/decisions.md` same-day entry):
   `sourceDatabaseV2` threaded through the shared IPC contract
   (`BurnExecuteArgs`, `burn`-channel-only — `diffBurn` never touches
   `database V2` at all), `main/ipcHandlers.ts`, and `registerIpc.ts`.
   Resolved Deliverable 6's open question: a real burn from the desktop
   app defaults to James's library backup
   (`E:\LIBRARY BACKUP 9_10_2026\_Serato_\database V2`), never his live
   `E:\_Serato_\database V2` — applied only when that backup file
   actually exists, so a machine without it still burns fine with the
   ordinary minimal synthesis rather than failing. UI is read-only for
   now (a fixed informational line on the "Burn to flash" card, not an
   editable field) — deliberate, matching this phase's risk-tiered
   posture; the IPC plumbing accepts a caller override already, so
   making it editable later is a UI-only change. The burn report now
   also surfaces `preservedCount` vs. `trackCount` (the "will this
   trigger re-analysis" signal) and warns if no already-analyzed source
   was found. `core` suite unchanged at 108 (clean); `desktop`'s
   `ipcHandlers.test.ts` suite: 13 tests (3 new), clean typecheck on
   main/preload/shared. The renderer (`App.tsx`) change itself was only
   verified with a lighter stub-based typecheck this session, not the
   full `tsconfig.renderer.json` pass against the real component tree —
   still worth James's own `npm run typecheck`.
   **Still open**: the actual hardware validation burn using this
   feature end-to-end — not started, deliberately not blocking this
   deliverable (see the phase's testing note below).
8. **Burn progress tracker — done, 2026-09-15** (`docs/decisions.md`
   same-day entry): a burn now reports live progress the same way a scan
   does, via a new `BurnProgress`/`BurnPhase` type and a shared
   `burn:progress` IPC channel — direct James feedback after Deliverable
   7 shipped ("the single spinner is a little ambiguous"). Five phases
   (`diffing`, `copying`, `writingCrates`, `writingDatabaseV2`,
   `verifying`), the first two itemized per-track with a running
   `processed`/`total`, the last three single-shot. `core` suite: 112
   tests (up from 108, +4), clean rebuild; `desktop`'s
   `ipcHandlers.test.ts`: 16 tests (+2), clean typecheck on
   main/preload/shared, plus a renderer stub-proxy typecheck for the new
   `BurnProgressBar` component.

Testing: same posture as Phase 2 — unit tests against synthetic trees,
property-based round-trip testing, nothing near James's real
`E:\_Serato_` at any point except read-only inspection to diagnose
Deliverable 6 (never written to). Real-hardware confirmation
(Deliverable 5), its follow-up fix (Deliverable 6), the UI wiring
(Deliverable 7), and the progress tracker (Deliverable 8) are not a
substitute for the automated suite that came before them — and the
phase's real final step is still ahead: a hardware validation burn using
the actual desktop UI end-to-end, not yet started.

## Phase 4 — Opt-in live migration (highest risk, latest, explicitly gated)

**Goal**: only once phases 2 and 3 are trustworthy, offer the option to
point your actual day-to-day `E:\_Serato_` at the canonical tree, so new
sorting happens against it going forward.

Deliverable: a guarded flow — mandatory full backup of the existing
`_Serato_` folder before anything is touched, a dry-run preview, and an
explicit, hard-to-fat-finger confirmation step. Not bundled quietly into
any other flow.

Testing: exercised only against backups/copies until the design is
solid. Before this is ever run for real, the rollback path (restore from
the automatic backup) gets tested and confirmed working — on its own,
before it's ever needed.

## Phase 5 — Rekordbox side (read side done; write side pending)

Rekordbox actually has two library formats, not one, and they're not
equally hard. The USB/CDJ export (`export.pdb` + `exportExt.pdb`) is
**not encrypted** and has been validated byte-for-byte against a real
file James provided (from a flash drive burned by his old system) —
page-chained tables, row-group indexing, real track paths extracted and
confirmed correct against the community-documented format (Deep
Symmetry's djl-analysis project). This is genuinely tractable, closer to
the Serato crate work than originally expected. The *other* format,
`exportLibrary.db`, is confirmed encrypted (no readable header) — that's
where the original "likely harder" caution still applies, and it stays
out of scope; nothing here touches it.

**Read side: done, for flat tracks and for the playlist/crate
hierarchy.** `packages/core/src/rekordbox/pdbReader.ts` — same async-
wrapper/pure-parser shape as the Serato readers — extracts
id/filePath/fileName/title per track (`__tests__/pdbReader.test.ts`, now
11 tests covering both the tracks table and the two playlist tables) and,
as of 2026-09-10, also reads the `playlist_tree` and `playlist_entries`
tables (Rekordbox's equivalent of Serato subcrates) and assembles them
into this project's CanonicalTree via the new
`packages/core/src/rekordbox/canonicalTree.ts` — the Rekordbox
counterpart to `serato/crateDatabaseReader.ts`
(`__tests__/canonicalTree.test.ts`, 7 tests). Validated against a second
real export, this one from a flash drive actually burned for and used on
real CDJ/Rekordbox hardware — 3,549 tracks, 431 playlist/folder nodes,
4,037 entries, run end-to-end through the real compiled reader
in-session, 0 orphaned entries, 0 leaked internal `_FolderTracks` nodes.
Full writeup, including the `_FolderTracks` handling decision, in
docs/decisions.md's 2026-09-10 entry. Not yet wired into IPC/UI —
core-only so far, same pattern the Serato readers followed before the
desktop app caught up.

**Write-side strategy: decided, 2026-09-15 (task #22 resolved — see
docs/decisions.md).** Template-modify a real, already-Rekordbox-exported
drive by appending new rows/pages to its existing table chains — never
rekordbox XML (an official interchange format, but with real limits: no
MyTags, no memory cue colors, no loop data, can't express deletions; and
it's literally how Lexicon syncs to *older* Rekordbox versions, per
Lexicon's own docs, which also say it moved to a different, more direct
method for modern Rekordbox — by elimination, touching Rekordbox's live
local database, which is explicitly not a path this project takes, same
reason Serato's live database stays untouched until Phase 4). Confirmed
with James: this means burn-to-Rekordbox always requires a drive that's
already been exported once by real Rekordbox — it cannot originate a
Rekordbox-readable drive from a totally blank one, unlike Serato's burn.
Accepted as the right tradeoff given there's no CDJ hardware to validate
a from-scratch writer against.

**Implementation: wrap `fragmede/rekordbox-pdb`'s `PdbEditor` rather than
build our own writer.** A GitHub survey (2026-09-15) found this
MIT-licensed, dependency-free Python library — already trusted as this
project's independent read-oracle, decision 23 — has a write path doing
exactly the agreed strategy: its own README describes it as editing "an
`export.pdb` the way rekordbox itself does — surgical, incremental
changes rather than rewriting the file," handling the row/page mechanics
(heap allocation, the row directory growing down from the page end,
presence/written bitmasks, >255-slot count encoding, fresh-page
allocation) that would otherwise be new reverse-engineering work with no
hardware to check it against. James's call: shell out to it as the
actual write mechanism rather than reimplementing it in TypeScript — real
speed/risk win, at the cost of a Python dependency in an otherwise
all-Node/Electron stack (packaging implication flagged below, not yet
resolved). Two other candidates surveyed and ruled out: `Holzhaus/rekordcrate`
(Rust) is read-only and pre-1.0 with an explicit "heavy development,
breaking changes" warning; `Deep-Symmetry/crate-digger` (Java) is
read-only. One real caveat carried forward from `PdbEditor`'s own docs:
it doesn't generate ANLZ analysis files, so an appended track still needs
Rekordbox/CDJ to analyze it before waveforms/beatgrids exist — an
inherent limit of this approach, not a bug to fix, and worth setting
expectations on up front (distinct from Serato's re-analysis
*regression*, decision 27, which was avoidable and got fixed).

Deliverables, in build order:
1. **Done, 2026-09-15** — vendored `PdbEditor` into `vendor/rekordbox-pdb/`
   (pinned commit, MIT license and attribution kept intact, full writeup
   in `docs/decisions.md`) and confirmed it standalone: its own 44-test
   suite passes in this project's sandbox; it reads the real reference USB
   James connected this session (`F:\PIONEER\rekordbox\export.pdb`) with
   counts matching this project's own reader exactly (3,549 tracks, 431
   playlist nodes, 4,037 entries); and a real append-track/append-playlist
   edit against a scratch copy of that same file changed only 355 of
   2,408,448 bytes (0.015%) with every original track untouched — direct
   proof the write path is genuinely surgical, not a hidden rewrite. The
   real `F:\` drive was never written to.
2. A thin main-process wrapper (`packages/core` or a dedicated adapter)
   that spawns the vendored script as a child process with a diffed set
   of items to add, capturing success/failure — same
   dependency-injection shape as every other handler in this project
   (the Python executable/script path passed in, not hardcoded, so tests
   can point it at a stub).
3. A `burnToRekordbox`-style orchestrator, parallel to
   `serato/burnToFlash.ts`: diff the canonical tree against what the
   *already-built* Rekordbox reader (`pdbReader.ts`/`canonicalTree.ts`)
   finds in the template's current `export.pdb`, using the same
   `TrackIndexStore` content-hash approach Serato's diff already uses —
   only the row-writing step delegates to `PdbEditor`, everything else
   stays this project's own TS code.
4. Read-back verification using this project's own already-validated
   reader (never trusting the writer's own success signal alone) — same
   posture as `verifyBurn`.
5. Hardware-adjacent trust gate, honest about the ceiling (decision 22
   applies here too, doubly so since this is someone else's write code):
   open a modified stick in real Rekordbox software and confirm by eye,
   since CDJ hardware isn't available.
6. Not blocking v1, but real: resolve how a Python runtime reaches a
   friend's machine before this ships beyond James's own — bundling a
   frozen executable per platform, versus requiring system Python for
   now while this stays single-user.

## Phase 6 — Beyond porting: library management features

Once the core cross-tool sync problem is solved, the tool can grow into
more than a mover of files:
- Audio tag reading/writing (artist, title, BPM, key) — the canonical
  tree is filesystem-only today; this is needed for anything beyond
  folder-level organization.
- Duplicate detection across the whole library (content-hash tracking
  from Phase 3 makes this nearly free once it exists).
- A real library browser/search inside the app, not just scan/plan/execute.
- Conflict resolution UI for a track that's diverged between Serato and
  Rekordbox.
- Backup/versioning for the canonical tree itself — once it's the actual
  source of truth, it needs its own protection story too.
- Move mode (deferred from v0) — revisit once copy has been trusted for a
  long stretch.

## Phase 7 — Polish and sharing

- Code-signed installer (today's is unsigned, which triggers an OS
  warning on first run — fine for you, worth fixing before handing this
  to friends).
- A real first-run experience for someone who isn't you: clearer errors,
  a setup walkthrough.
- CI expansion: e2e tests running in the pipeline, coverage reporting.
- This project doubles as a QA/SDET portfolio piece — once there's enough
  built and tested, a written test-strategy doc and a case-study write-up
  are natural deliverables in their own right, not just side effects of
  building the app.

## Testing strategy, end to end

The shape of the test pyramid changes as the project gets riskier, not
just bigger:

- **Unit** (Jest, `core`) — cheapest, fastest, the majority of coverage,
  already the most built-out layer.
- **Integration** (IPC handlers) — still fast, no real Electron runtime
  needed, already started.
- **E2E** (Playwright `_electron`) — slower, fewer of them, driving the
  actual packaged UI. Not started yet; Phase 1's first deliverable.
- **Manual/exploratory** — session-based test charters run by hand
  against your real library, reserved for what automated coverage
  structurally can't replace (does this feel right against real data?).
- **Data-safety tests** — a distinct category from ordinary bug-hunting,
  reserved for anything that writes to a real DJ tool's own format:
  round-trip proofs, backup/restore verification, failure injection. This
  category doesn't exist for Phase 0/1 work (nothing there writes to
  Serato's database) and becomes the dominant concern from Phase 2 on.
