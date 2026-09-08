# Decisions log

Lightweight ADR-style log of the choices behind this project. Newest first.

## 2026-09-08 — Crate writer, round-trip proven (Phase 2 core deliverable)

Built the inverse of the crate reader: `packages/core/src/serato/
crateDatabaseWriter.ts`, `writeCrateDatabase(tree, subcratesDir,
{ volumeRoot })`. Mirrors the reader's byte format exactly -- same `vrsn`
header, same `otrk`/`ptrk` chunk nesting, same UTF-16BE encoding, same
"relative, forward-slash, no drive letter, resolved against the parent of
`_Serato_`" path convention -- since the two only mean anything as a
matched pair.

**Design choice: one node with direct tracks = one crate file.** Matches
the reader's already-established "one crate = one folder" model (see the
2026-09-01 entry) exactly -- a `CanonicalNode` with only children and no
tracks of its own (a purely organizational "folder") gets no `.crate`
file, since Serato's crate-tree UI infers that structure from filename
`%%`-prefixes alone and doesn't need a file at every level to exist.

**Three guards, because a silent failure here is the actual risk this
phase exists to manage:**
- A folder name containing `%%` is rejected outright -- writing it would
  silently corrupt the hierarchy the moment it's read back, since that's
  the reader's own hierarchy separator.
- A track whose source path isn't under the given `volumeRoot` is
  rejected outright, rather than writing a relative path that resolves to
  nothing (or worse, something else) on read-back.
- Tracks living directly on the tree's root (no folder at all) are
  returned as `skippedRootTracks` rather than silently dropped -- Serato's
  Subcrates model has no "uncrated" bucket, so there's no correct file to
  write them into, and the caller needs to know rather than lose tracks
  quietly.

**Round-trip test suite** (`__tests__/crateDatabaseWriter.test.ts`, 4
tests): write a hand-built canonical tree, read it back with the already-
trusted reader, and deep-equal the shapes. Covers nested crates, unicode
in both folder and file names, an empty intermediate folder (proving it
correctly gets no file), and the same physical track referenced from two
different crates. Every track points at a real placeholder file, so the
read-back pass also proves `unresolvedCount` comes back `0` -- a genuine
end-to-end round trip, not just a structural one. All passing; full
`core` suite is now 34 tests, green; `dist/` rebuilt.

**What Phase 2 still needs before it's actually trusted, per
`docs/roadmap.md`:** property-based/generative round-trip testing (random
trees, not just hand-picked fixtures -- flagged in the roadmap as worth
the setup cost specifically because this is a binary format), and the one
manual checkpoint that can't be automated at all -- write to a real
scratch flash drive and open the result in actual Serato to confirm by
eye. Not wired into desktop IPC/UI yet either; this is core-only, same
"logic lands before the UI catches up" pattern as everything else in this
codebase.

## 2026-09-08 — One `npm run verify` for everything

James's call: checking build/typecheck/tests/e2e as separate manual steps
doesn't scale once that's the normal pre-"call it done" routine -- one
command should run the whole chain. Added:

- `packages/core`: a `typecheck` script (`tsc --noEmit`), matching the one
  `packages/desktop` already had -- previously only desktop could be
  typechecked on its own without a full `tsc` emit.
- Root `package.json`: `typecheck` (fans out to both workspaces, same
  `--if-present` pattern the existing `build`/`test` scripts already use)
  and `test:e2e` (delegates to `packages/desktop`, the only workspace with
  a UI to e2e-test).
- Root `verify`: `build && typecheck && test && test:e2e`, in that order
  -- build has to come first since desktop's typecheck and the e2e run
  both need `@mlo/core`'s compiled `dist/` to exist, and e2e specifically
  needs a fresh `out/` to launch against.

Confirmed **`npm test` alone was not equivalent to this** -- it only runs
each workspace's `test` script (the two Jest suites), never `build`,
`typecheck`, or `test:e2e`. `npm run verify` is the actual "did I break
anything" command going forward; plain `npm test` stays useful on its own
for a fast unit-test-only loop while iterating.

Ran the new scripts individually against this session's environment to
confirm the wiring: `build`, `typecheck` (clean on both packages -- no
errors, including desktop's renderer tsconfig), and `test` (36/36
passing) all work end to end. `test:e2e`'s underlying `playwright test`
still can't actually launch on this session's Linux bridge for the
platform/network reasons noted in the previous entry -- that part of
`verify` needs to be run on James's own machine, same as before; this
change doesn't remove that gap, it just makes it the last step of one
command instead of a step you'd remember to run separately.

## 2026-09-08 — First Playwright `_electron` e2e test

Added the first real UI-driving e2e test (task #17, part of Phase 1):
`packages/desktop/playwright.config.ts` + `packages/desktop/e2e/
scan-plan-execute.spec.ts`, using Playwright's `_electron` support to
launch the actual built app and drive the whole scan → plan → dry run →
execute pipeline through its real UI, in folder-tree mode, against a
small checked-in synthetic fixture (`e2e/fixtures/synthetic-library/` —
5 tracks across a nested folder tree; never James's real `E:\_Serato_`,
same fixture discipline as the Jest suites). Asserts against the actual
filesystem afterward — dry run must not create any files, execute must
create exactly the files the canonical tree implies, at the exact paths
`planFromCanonicalTree` computes.

**One real, load-bearing pattern worth calling out**: the "Browse…"
buttons call `dialog.showOpenDialog`, a real native OS dialog Playwright
can't drive directly. The test stubs it in the Electron main process
(`electronApp.evaluate(({ dialog }) => { dialog.showOpenDialog = ... })`,
the documented Playwright/Electron pattern) with a small queue of paths,
resolved in the order the UI triggers them — source folder, then target
root.

**Verified as far as this environment allows, not further — an honest
gap, not a finished checkbox.** `packages/desktop/node_modules/electron`
here is the Windows build (this repo lives on a OneDrive folder normally
built from James's Windows machine), and this session's remote-device
shell is a separate Linux VM — genuinely can't execute a Windows `.exe`.
Attempted to install a Linux-platform Electron into a separate scratch
directory to at least prove the test runs end-to-end; that download goes
through `github.com`, which isn't reachable from this shell's network
egress either. What *is* verified here: `npx playwright test --list`
discovers the spec correctly, and a standalone `tsc --noEmit` pass over
the spec and config is clean — so the test is structurally sound and
type-correct, but it has not yet actually launched the app and watched
it pass. **James needs to run `npm run test:e2e` (builds, then runs
Playwright) from `packages/desktop` on his own machine** to get the
first real pass/fail signal — this is the same "needs his terminal"
limitation already noted for the installer (task #11), for the same
underlying reason (this bridge can't run his platform's Electron
binary).

## 2026-09-08 — Rekordbox reader: from validated prototype to real, tested code

Ported the Python validation prototype (previous entry) into
`packages/core/src/rekordbox/pdbReader.ts`, matching the shape of the
existing Serato readers: an async `readPdbTracks(path)` wrapper around a
pure `parsePdbTracks(buffer)` function, so the parsing logic itself is
synchronous and directly testable without touching disk.

- **Tests use synthetic buffers, not James's real export files.** A small
  buffer-builder (`__tests__/pdbReader.test.ts`) constructs minimal but
  format-correct pages by hand — same reasoning as the Serato crate
  tests: real personal library data never belongs in the repo's fixtures,
  and a synthetic buffer that exercises every code path (short strings,
  long/UTF-16LE strings, multi-row pages, multi-page chains, index-page
  skipping, an empty tracks table) is a stronger regression test anyway,
  since it's not hostage to whatever happens to be in one real file.
- **A real bug the tests caught immediately**: the first version of the
  non-ASCII test case only marked the *title* field as long/UTF-16LE and
  left `filePath`/`fileName` on the short/ASCII encoding, even though
  both also contained "clé" — so the test buffer itself silently mangled
  the accented character before the parser ever ran (`clé` → `cli`,
  ASCII-truncating the é). Fixed in the test builder, not the reader —
  this was a synthetic-data bug, not a parsing bug, and it's a good
  example of why round-tripping through a hand-built encoder is worth
  the extra care. All 6 tests pass; the full `core` suite (30 tests) is
  green.
- **Scope check**: this reads flat track rows only — id, file path, file
  name, title. Playlist/crate hierarchy (the Rekordbox equivalent of
  Serato subcrates) is not implemented yet; the PDB format almost
  certainly stores it as its own tables (playlist entries reference
  track ids), but that hasn't been validated against real data the way
  track rows have. Next Rekordbox step, when picked back up: extend the
  reader to the playlist tables, then decide the write-strategy question
  (task #22).
- `packages/core`'s `dist/` was rebuilt (`tsc`) so the new export is
  available to consumers; nothing in `desktop` references it yet — this
  is core-only, unwired, by design (mirrors how the Serato readers landed
  before the UI caught up to them).

## 2026-09-01 — Initial scope and stack

- **Goal**: a shared, tool-agnostic folder structure that both Serato and
  Rekordbox can be pointed at, so the DJ library isn't organized twice.
  Step one is just: read the current Serato organization, and copy files
  from the inbox into a new folder tree that mirrors it.
- **Stack**: Node/TypeScript for both backend and frontend (Express API +
  React/Vite frontend), one language across the stack. Chosen over a
  Python backend so existing Playwright/Jest/Cypress testing experience
  carries over directly — this project doubles as a QA/SDET portfolio
  piece with real test automation against it.
- **Copy vs. move**: start with **copy only**. Originals stay untouched in
  Serato's current structure until the mapping logic has been verified
  against a real library. Move is an explicit, opt-in follow-up — the
  motivation being that keeping two full copies of an MP3 library wastes
  real disk space, so this is a deliberate "prove it first" tradeoff, not
  a permanent choice.
- **How Serato's structure is actually stored**: unconfirmed. It could be
  real OS folders under the Serato-managed volume, Serato's internal crate
  database (`_Serato_/Subcrates/*.crate` files, which can reference files
  anywhere), or a mix of both per crate. `core` implements readers for
  both cases (`serato/folderTreeReader.ts`, `serato/crateDatabaseReader.ts`)
  behind a common interface, plus a `detectSourceType` heuristic, so the
  app can handle "mixed" libraries. The crate-database reader is
  **best-effort and unverified** — see
  [`serato-crate-format.md`](serato-crate-format.md) — and needs to be
  checked against a real library (library lives on a flash drive) before
  it's trusted.
- **Architecture**: local web app, not a hosted service. The API needs
  direct filesystem access to the user's library, so it's designed to run
  on the same machine as the music, not on a server other people's data
  passes through. "Share with friends" means friends run their own copy
  against their own library, not a multi-tenant hosted product (that could
  change later, but isn't the v0 design).
- **Repo**: private GitHub repo. No GitHub CLI/connector was available in
  the environment that scaffolded this, so the initial commit needs to be
  pushed manually — see the setup note at the bottom of this file.

## 2026-09-01 — Crate-to-folder mapping: one crate = one folder

Serato crates are non-exclusive (a track can be in several at once), which
raised the question of which crate should "win" as a track's canonical
folder. James's call: don't overcomplicate it — **one crate = one folder,
always.** No classification into "placement" vs. "utility" crates, no
picking a winner. Every crate (genre, artist, gig-prep, whatever) becomes
a folder; a track that's in multiple crates gets copied into all of them.
This needed no code changes — `crateDatabaseReader.ts` and `planner.ts`
already treat every crate independently — it just needed confirming as
the intended behavior, not a bug to fix. Covered by
`__tests__/crateOrganizer.test.ts`.

## 2026-09-01 — Adopt the portfolio's design system

James's portfolio site (`_Portfolio/portfolio`) became the reference for
this project's UI, replacing `App.tsx`'s ad-hoc inline `style={{...}}`
props. Full reasoning and the rules themselves live in
[`design-system.md`](design-system.md); the short version:

- **Tokens, not hardcoded values.** A `theme.css` with `light-dark()`
  color tokens, a three-radius rule (12px/4px/999px), and a spacing scale,
  mirroring the portfolio's `:root` custom properties.
- **CSS Modules + atomic-design structure** (`components/atoms`,
  `components/molecules`), same as the portfolio, instead of one big
  component file.
- **Deliberate divergence: system font, not the portfolio's licensed
  font.** The portfolio's headings use `TBJ-Orcherum`, fetched from a
  private repo at build time via a token. Reusing it here would make this
  project depend on that same private token to build — not appropriate for
  something meant to be shared with friends. Asked James directly rather
  than assuming; he chose the system font stack and keeping everything
  else (colors, radii, component patterns) as-is.

## 2026-09-01 — Pivot to an Electron desktop app

The tool only ever touches files on James's own machine, and
Serato/rekordbox/Lexicon are themselves desktop apps, not browser tools —
so, per the earlier sequencing decision ("validate first, then
repackage"), with the crate-reader logic now validated, this repackages
the local web app as an Electron desktop app.

- **IPC over HTTP, deliberately, for the learning value.** The renderer
  could have kept calling an Express server running inside Electron's main
  process — that would've reused `server` almost unchanged. Instead the
  Express layer was replaced with native `ipcMain.handle` /
  `ipcRenderer.invoke`, which is the idiomatic Electron pattern (no open
  local port, and it's the security-relevant part of Electron most worth
  understanding). See `docs/architecture.md` for the process model and the
  `contextBridge` security boundary.
- **One package, not three.** `server` and `web` are retired in favor of a
  single `desktop` package (`src/main`, `src/preload`, `src/renderer`),
  following `electron-vite`'s convention. Reasoning: renderer and main
  process always ship together as one installer in Electron — there's no
  independent-deploy reason to keep them in separate packages once that's
  true, the same logic that ruled out a separate repo for "backend" work.
  `core` stays its own package because it's the one part that's genuinely
  reusable on its own timeline (a future CLI, a hosted API, Rekordbox
  tooling).
- **Tooling**: `electron-vite` for dev (Vite + HMR for the renderer, watch
  + restart for main/preload, one config), `electron-builder` for
  packaging (the standard choice; `electron-forge` was the alternative).
- **Fixed while porting**: the old Express `/organize/plan` re-scanned the
  root path from scratch and only ever used the folder-tree reader, so a
  crate-database scan could never actually be planned. `planOrganize` now
  takes the tree the renderer already scanned instead of re-deriving it,
  and the desktop UI has an explicit folder-tree-vs-crate-database toggle.
- **Verified, not just type-checked**: `electron-vite build` produces real
  main/preload/renderer bundles, and the built app was smoke-launched
  headless (`xvfb-run`) — it created its window and ran stably; the only
  errors were expected sandbox noise (no D-Bus, no GPU, network egress
  restrictions in the build environment), nothing from the app's own code.

## 2026-09-08 — Rekordbox research: the read side is real, the write side has options

James connected `F:\PIONEER` (a flash drive burned by his old library
system) to validate Phase 5 assumptions against real data, same pattern as
the Serato work. Two distinct formats found, and the picture is better
than the original caution suggested:

**`export.pdb` + `exportExt.pdb` (the classic USB-export/CDJ format) —
NOT encrypted, and validated byte-for-byte against the real file.**
Cross-referenced the binary layout against Deep Symmetry's djl-analysis
documentation (the authoritative community reverse-engineering reference —
see sources below), then wrote a Python prototype and ran it against
James's actual `export.pdb`: paged (4096-byte pages) with tables as
linked lists via `next_page`, rows indexed by 36-byte groups built
backward from the end of each page (16 rows/group, a presence bitmask,
slots read in reverse order), row address = `page_offset + 0x28 +
row_offset`. Confirmed correct by finding the track row's fixed subtype
marker (`0x0024`) at every computed address across multiple pages, and by
recovering real track paths (e.g.
`/Contents/Phazed/Wildfire/50 - Phazed - Wildfire.mp3`). This is
genuinely tractable — closer in spirit to the Serato crate work than the
"probably an encrypted database" caution from the original roadmap entry.

**`exportLibrary.db` — genuinely encrypted**, confirming the other half
of that original caution. No recognizable header (real SQLite files start
with `SQLite format 3\0`; this doesn't), consistent with SQLCipher-style
full-file encryption. Left alone — no attempt made to decrypt or otherwise
access it.

**Write side: three options surfaced, one favored.** James asked directly
whether we could just modify an existing burn rather than generate a
Rekordbox export from nothing — yes, and it's the better strategy:
tables are page-chains, so new tracks/playlist entries can likely be added
by *appending* new pages to a real, valid export's existing chains,
inheriting all the correctly-formed supporting tables (artists, albums,
genres, etc.) rather than reconstructing everything. One open unknown:
whether the index page found at the head of the tracks table matters for
CDJ/Rekordbox lookups, or whether the `next_page` chain alone is
sufficient — needs an answer before committing. The alternative
researched was **rekordbox XML**, an official documented interchange
format — notably, this is literally how Lexicon (the tool this project
is trying to beat) syncs to Rekordbox 5, per Lexicon's own docs. It has
real limits (no MyTags, no memory cue colors, no loop data, can't handle
deletions, and Lexicon's own docs call it "very slow"), and Lexicon
itself uses "a Direct method that skips the XML" for Rekordbox 6/7 —
which, by process of elimination, means touching Rekordbox's own live
local (encrypted) collection database. That path is explicitly not being
pursued here, for the same reason Serato's live database stays untouched
until much later: it's the one thing a person actually depends on day to
day. Current lean is PDB template-modification — see task #22 for the
full writeup and the decision still to make.

Sources consulted: [Database Exports — DJ Link Ecosystem Analysis](https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/exports.html),
[rekordcrate (Holzhaus)](https://github.com/Holzhaus/rekordcrate),
[Lexicon: Sync to Rekordbox (XML)](https://www.lexicondj.com/manual/sync-rekordbox-xml).

## 2026-09-08 — Selective copy: a toggle tree over the scanned library

James's call: with the tool now doing full writes (copying real files), he
wants real control over what gets copied, not just an all-or-nothing
scan-to-plan pipeline. Added a checkbox tree over the scanned crates/
folders (`packages/desktop/src/renderer/src/components/molecules/
SelectionTree`) — unchecking a crate or folder excludes it, and its whole
subtree, from the plan. There's no way to exclude a parent while keeping
one of its children; a child under an excluded parent shows disabled
rather than supporting an independent "carve-out," which keeps the
exclusion state small (one key per top-most excluded node) and predictable
rather than needing to track re-inclusions separately.

**Where the filtering actually happens, and why:** `@mlo/core` gained a
new `organizer/selection.ts` (`filterTreeBySelection`, `nodeKey`) — a
pure, tested function that drops excluded subtrees from a `CanonicalTree`.
The renderer only ever manages *which keys are checked*; the IPC contract
carries that as a plain `excludedKeys: string[]`, and `planOrganize`
(main process) does the actual filtering before calling
`planFromCanonicalTree`. This keeps the same rule the project has followed
throughout: real logic lives in `core`, tested with Jest; the renderer is
presentation plus thin IPC calls. It also means a filtered plan is real,
not cosmetic — `plan.items` reflects exactly what's checked, verified by
an IPC-level test (`ipcHandlers.test.ts`) proving `excludedKeys` actually
shrinks the resulting plan.

Nodes default to selected (nothing excluded) on a fresh scan, so this is
additive — the existing "copy everything" behavior still happens if the
tree is left untouched.

## 2026-09-02 — End-state architecture: source of truth + "burn to flash"

James's mental model, confirmed: the canonical tree isn't just a mirror to
look at — it's meant to become the actual source of truth, with two
distinct consumers of it:

1. A **local library** on his PC — the canonical folder tree itself, which
   `core`/`desktop` already build today (copy-only, non-destructive).
2. A **"burn to flash"** export — take that canonical tree and write out a
   real `_Serato_` folder (audio files + a freshly-generated crate
   database) onto a target volume, so *any* Serato install, on *any*
   machine, sees the full crate structure the moment that drive is
   plugged in. This is the "plug and play on any Serato system, full
   stop" outcome — no dependency on which machine's Serato database
   things happen to live in.

This is functionally the same problem Rekordbox already solves for itself
with its native "export collection to a USB device" feature — Serato has
no first-party equivalent, which is a big part of why a tool like this (or
Lexicon) has value at all.

**Two different "write Serato" operations — kept deliberately separate,
because James has 5 years of library work riding on this:**

- *Writing a fresh crate database onto a new/scratch volume* (burn to
  flash) is comparatively low-risk: it never touches anything James
  currently relies on. Worst case, a bad export is just deleted and
  re-run.
- *Pointing James's live, currently-in-use `_Serato_` database at the
  canonical tree* — so that day-to-day sorting happens against the
  canonical folder instead of today's setup — is a much later, much
  higher-risk step, because it means writing into the one database Serato
  actually uses right now.

**Sequencing, in order, each gated on the previous one being solid:**

1. Finish packaging/testing the current copy-only tool (already in
   progress — see "Open questions" below).
2. Build a **crate writer** — the inverse of the already-validated crate
   *reader* — that can generate a valid `.crate` file set from a canonical
   tree. Prove it by round-tripping: write, then read the result back with
   our own trusted reader, and diff against the source tree. All of this
   happens only against a scratch folder or a spare/test flash drive —
   never James's real `E:\_Serato_` — until it's been proven correct many
   times over.
3. Ship "burn to flash" as its own feature: canonical tree (already on
   James's PC) → a freshly-written `_Serato_` structure on a chosen target
   volume. This is the deliverable that makes the library portable to any
   Serato rig.
4. Only after (2) and (3) are trustworthy: consider, as a separate and
   explicitly opt-in step, pointing James's actual live Serato setup at
   the canonical tree — and even then, back up the existing `_Serato_`
   folder in full before that step ever runs.

**Why this changes the track-identity question's priority.** "Burn to
flash" needs to know what's already on a given flash drive versus what's
new since the last burn, so re-burning doesn't mean re-copying the entire
library every time. That makes the track-identity strategy (filename vs.
content hash vs. tags — see below) no longer a someday question; it's a
prerequisite for burn-to-flash being practical rather than just correct.

## Open questions / next decisions

Full phase-by-phase plan, deliverables, and required testing now live in
[`roadmap.md`](roadmap.md). Short version of what's immediately open:

- Decide the canonical target root's location (same flash drive? a new
  drive/folder both Serato and Rekordbox get pointed at?).
- Package a real installer (`electron-builder`) and actually install/run
  it on James's machine — the smoke test above proves the app boots, not
  that the full UI flow works end to end on real hardware.
- Real UI-driving e2e tests via Playwright's Electron support (`_electron`)
  — ties directly into James's existing Playwright/Electron testing
  experience, tracked as the next portfolio-relevant testing milestone.
- Decide track-identity strategy for future syncing (filename? content
  hash? tags?) — now a prerequisite for burn-to-flash (see above), not a
  someday item.
- Build the Serato crate **writer** and the "burn to flash" export flow
  (see the 2026-09-02 entry above) — always against scratch/test volumes
  first, never James's live `E:\_Serato_`.
- Design the eventual Rekordbox side (Rekordbox's own database format is a
  separate reverse-engineering problem from Serato's) — lower priority
  now that Rekordbox already has its own native USB export.

## Manual repo setup (one-time)

1. Create a new **private** repository on GitHub (no README/gitignore —
   this project already has both).
2. From this project's root:
   ```bash
   git init
   git add .
   git commit -m "Initial scaffold: canonical model, Serato readers, copy-first organizer"
   git branch -M main
   git remote add origin git@github.com:<you>/<repo-name>.git
   git push -u origin main
   ```
