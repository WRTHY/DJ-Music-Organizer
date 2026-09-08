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

## Phase 2 — Crate writer, proven in isolation

**Goal**: build the write half of the Serato format — the highest-risk
piece of engineering in this whole project — and don't let it near
anything real until it's been proven wrong a lot of times in a sandbox.

Deliverables:
- `packages/core/src/serato/crateDatabaseWriter.ts`, the mirror of the
  already-validated reader.
- A round-trip test suite: canonical tree → write → read back with the
  trusted reader → deep-equal diff. Covers nested crates, the `%%`
  hierarchy, unicode names, empty crates, one track in several crates.
  Property-based/generative testing (random canonical trees, not just
  hand-picked fixtures) is worth the setup cost here specifically, because
  this is a binary format — the bugs that matter are the ones you didn't
  think to write a fixture for.
- One manual checkpoint that can't be automated: write to a **scratch**
  flash drive (never `E:\_Serato_`), open the result in real Serato,
  confirm by eye that it matches. This is the actual trust gate for
  everything after this phase.

## Phase 3 — Burn to flash

**Goal**: the feature that actually delivers "plug and play on any Serato
rig" — take the canonical library and write a fresh, complete `_Serato_`
structure onto a target drive.

Deliverables:
- Track-identity strategy implemented — content hash, since it's the only
  option that survives a rename or move without either losing track of a
  file or duplicating it.
- Incremental burn: diff the canonical tree against what's already on the
  target drive, copy only what's new or changed, rewrite only the crates
  that changed — so re-burning a 5-year library isn't a full re-copy every
  time.
- **Generalizes beyond burn-to-flash** (James, 2026-09-08): the same
  diff-against-the-destination idea applies to the ordinary copy-to-
  canonical-tree step too, not just burning to a flash drive — compare
  what's already at the target against what the scan found, and only
  actually copy what's new or changed there as well. Same content-hash
  identity work covers both; this is the reason track-identity moved up
  to a Phase 3 prerequisite rather than staying deferred.
- UI flow: pick a target drive → preview (what's new, what's unchanged) →
  burn → automatic verification pass (read back what was written, diff
  against source) before calling it done.

Testing:
- Round-trip *and* incremental-diff tests (burning twice in a row should
  copy nothing the second time).
- Real hardware test: burn to an actual spare flash drive, and if a second
  physical Serato rig is available, confirm the drive works there too.
- Failure injection: drive unplugged mid-burn, drive fills up mid-copy —
  must fail safely, never leave a half-written crate database behind.

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

## Phase 5 — Rekordbox side (research first)

Rekordbox's library format is a different, likely harder problem than
Serato's — modern Rekordbox versions store their library in an encrypted
SQLite database rather than Serato's plain binary crate files, which is a
meaningfully bigger reverse-engineering lift. This phase starts with
research and validation (same pattern as Serato: build a read-only reader
first, validate it against your real Rekordbox library) before any scope
gets committed to beyond that. A writer for Rekordbox, if it turns out to
be feasible at all, follows the same isolated-then-proven pattern as
Serato's did.

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
