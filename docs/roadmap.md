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
1. **Research**: `database V2` is undocumented the same way the crate
   format was, but less obscure — reverse-engineering it has already
   been done by others in the course of building Serato-library import
   for other DJ software (the same category of source that led to
   `fragmede/rekordbox-pdb` being a genuine independent oracle for the
   Rekordbox side, per the 2026-09-10 entry in `docs/decisions.md`).
   Find that prior art first rather than starting from zero. Then
   validate directly against a real file already on hand — James's own
   library backup has one at
   `E:\LIBRARY BACKUP 9_10_2026\_Serato_\database V2` (~8 MB) — the same
   "confirm against a real library" step that validated the crate
   format on 2026-09-01. Specific open questions to resolve before
   writing any code:
   - Same outer chunk framing as `.crate` files (4-byte tag + 4-byte
     big-endian length), or something else at the top level?
   - What fields are actually *required* for Serato to treat a track as
     known and show it in a crate — versus fields Serato merely
     displays (title, artist, BPM, key, etc.) but can regenerate or
     leave blank without refusing the entry? Minimum viable is likely
     smaller than the full field set Serato itself writes.
   - Does `database V2` encode crate membership at all, or is that
     purely the separate `.crate` files, as assumed? (Current working
     assumption, per `serato-crate-format.md`, is the latter —
     confirm rather than continue assuming.)
   - Per-track analysis data (waveform, cues, beatgrid) — confirmed
     working assumption is that it lives in the audio file's own ID3
     GEOB frames, not in `database V2`, which would mean this project's
     existing `fs.copyFile`-based copy already carries it over for
     free. Worth confirming explicitly rather than leaving implicit,
     since it's the kind of assumption that's easy to get quietly wrong.
   - Any checksum, version counter, or other integrity field Serato
     checks before trusting the file, the way `vrsn` works in `.crate`
     files.
2. **Reader** (`packages/core/src/serato/databaseV2Reader.ts`): prove
   the format is understood before writing anything — mirrors how
   `crateDatabaseReader.ts` came before `crateDatabaseWriter.ts`.
   Validated by parsing James's real `database V2` and cross-checking
   whatever's extractable against what Serato itself already shows for
   that library (track count at minimum; more if practical).
3. **Writer, blank-drive case only** (`databaseV2Writer.ts`): given a
   `CanonicalTree`, write a `database V2` from nothing — no existing
   file to merge against. Round-trip tested the same way
   `crateDatabaseWriter.ts` was: write → read back with the new reader
   → diff, plus property-based testing for tree-shape coverage, all
   against scratch/synthetic data only.
4. **Wire into `burnToFlash.ts`**: alongside the existing
   `writeCrateDatabase` call, so a burn to a target with no prior
   `_Serato_` folder produces both — but only for that case (detect an
   existing `database V2` at the target and refuse/skip rather than
   guess, until the merge case in a later phase exists).
5. **Trust gate, same pattern as Phase 2/3**: proven against scratch
   fixtures and round-trip tests first; the actual hardware checkpoint
   is burning to a genuinely blank drive and confirming Serato shows
   the library **without** the manual "add folder" step this phase
   exists to remove.

Testing: same posture as Phase 2 — unit tests against synthetic trees,
property-based round-trip testing, nothing near James's real
`E:\_Serato_` at any point (there's no reason this phase should ever
touch it; it only writes to drives that don't have a `database V2`
yet). Real-hardware confirmation is the final step, not a substitute
for the automated suite.

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

Write-side has a decision pending (task #22): template-modify a real,
valid export by appending new pages to its existing table chains
(favored — produces a portable USB export symmetric with Serato's
burn-to-flash, needs no Rekordbox installation), versus rekordbox XML (an
official interchange format, but with real limits — no MyTags, no memory
cue colors, no loop data, can't express deletions). Notably, rekordbox
XML is literally how Lexicon syncs to older Rekordbox versions per its
own documentation — and Lexicon's own docs say it moved to a different,
more direct method for modern Rekordbox, which by elimination means
touching Rekordbox's live local database. That's explicitly not a path
this project is taking, for the same reason Serato's live database stays
untouched until Phase 4: it's the thing someone actually depends on.

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
