# Decisions log

Lightweight ADR-style log of the choices behind this project. Newest first.

## 2026-09-10 — Independent-oracle cross-check of the Rekordbox reader: exact match, plus a corrected row-count safety finding

James asked directly: "take a look at pyrekordbox and this repo and cross
check our process" (`davehenke/rekordbox-mcp`). This is the kind of
check that answers "is this even the right way to be parsing this,"
independent of anything Claude or this project wrote -- the previous
entry's "self-verification has a hard ceiling" point, actually acted on
rather than just stated.

**`pyrekordbox` (dylanljones) does not apply here -- correcting my own
prior suggestion.** I had recommended it earlier without verifying it.
On inspection, its API only covers the newer `exportLibrary.db`
SQLite-based "Device Library Plus" format used by newer hardware
(OPUS-QUAD, OMNIS-DUO, XDJ-AZ); it does not read the classic
`export.pdb`/`exportExt.pdb` format this project targets, at all. Ruled
out, not used.

**`davehenke/rekordbox-mcp` is a live-database tool, not a USB-export
tool.** It's an MCP server wrapping `pyrekordbox` against Rekordbox's own
local encrypted `master.db`, for querying your collection from an
assistant -- a different problem (live app database vs. a burned USB
export) and not directly comparable to this project's read/write path.

**`fragmede/rekordbox-pdb`** (Python, MIT, dependency-free) turned out to
be the real find: an independently-written, independently-maintained
parser of the exact classic `export.pdb`/`exportExt.pdb` format this
project reads, with its own from-scratch format documentation
(`FORMAT.md`) cross-checked by its author against Deep Symmetry's
Kaitai/crate-digger spec. This is a genuine independent oracle. Cloned
it, installed it, and ran it against the real hardware-burned
3,549-track/431-node/4,037-entry library (the same drive used to build
and validate the playlist reader), then built a from-scratch Python
reimplementation of `buildCanonicalTreeFromPlaylists`'s exact fold logic
on top of its parsed output, and diffed that against the TypeScript
implementation's own output on the same file, flattened by full node
path.

**Result: exact match. 393/393 canonical nodes (392 real + the synthetic
root), 0 paths only in one side, 0 mismatched paths.** Table layout,
table type numbers (7 = playlist_tree, 8 = playlist_entries),
`playlist_tree`'s row layout, and `playlist_entries`'s row layout all
match FORMAT.md byte-for-byte against this project's own
`pdbReader.ts`. One new fact worth carrying forward: **playlist ids are
not stable across re-exports** -- Rekordbox reassigns them when the USB
is re-exported -- which should inform the still-undecided Rekordbox
write-side design (task in `roadmap.md`; template-modify approach looks
more right than "reuse ids across exports" in light of this).

**A specific, known bug class was checked against and ruled out.**
FORMAT.md documents that the widely-used "`num_rows_large` (@0x22) if
larger and ≠ 0x1fff" heuristic for a page's row/slot count --
used by crate-digger, and (per FORMAT.md's own note) by earlier versions
of *this* project -- is wrong: @0x22 holds the slot count as of the
page's *previous* write, and on any page that ever exceeded 255 slots it
silently drops rows (FORMAT.md cites a real 713-track export that loses
78 live history entries this way). This is exactly the kind of
issue this whole exercise exists to catch -- silent data loss, not a
crash. Checked our current `readRowOffsets`
(`packages/core/src/rekordbox/pdbReader.ts`): it does **not** read
@0x22 at all, and never has, as far as this cross-check reaches. It
reads `u8@0x18` combined with the low bits of the `u16@0x19`, masked to
13 bits. Algebraically, that reduces to FORMAT.md's stated-correct
formula (`n = u8@0x18 + 0x100 * (u8@0x19 & 1)`) on every valid page,
because the bits our mask keeps beyond bit 0 of `u19` (bits 1-4) are
structurally always zero there (`u16@0x19` is `0x20 * present_rows` with
only bit 0 repurposed as the overflow flag, and 0x20 is a multiple of
32, so bits 0-4 of a clean multiple of 32 are 0 except for the one bit
that got overridden). So the two formulas are not just similar, they are
the same function on every real page. This is corroborated empirically,
not just algebraically: `playlist_entries` rows are 12 bytes each, so a
4096-byte page holds on the order of 300+ of them -- comfortably over
the 255-slot threshold where the buggy heuristic fails -- and all 4,037
real entries round-tripped with zero mismatches against the independent
library above. **Conclusion: this project's row-count decoding was
already correct and is not vulnerable to this bug class** -- no code
change required, only this finding recorded so the reasoning doesn't
have to be redone from scratch later.

**What this doesn't prove**: still not a substitute for a real CDJ/XDJ
actually reading the drive -- it proves this project's parser agrees
with a second, independently-written parser on the same real,
hardware-burned file, which is the strongest check available without
hardware, not equivalent to hardware itself.

## 2026-09-10 — Burn verification closes a real gap: a track silently reassigned to the wrong crate was invisible to it

James raised a legitimate worry, not an edge case to wave off: he has no
CDJ/Rekordbox hardware to test a burn against, has previously trusted a
burn that turned out to have a folder wrong once he actually got to a
gig, and asked whether there's any way to validate a burn will actually
work without hardware in hand. Two separate things are true at once
here, and both are worth saying plainly rather than picking the
comfortable one:

**There is a hard ceiling on what self-verification can prove.**
`verifyBurn` reads the just-written crate database back with this
project's *own* reader and compares it to what was intended. That can
only prove internal self-consistency -- that the writer and the reader
agree with each other -- never that real Serato (or, once Phase 5's
write side exists, a real CDJ) agrees too. If the reader and writer ever
shared a wrong assumption about the format, a round-trip check would
stay green while the real application silently disagreed. No amount of
re-reading our own output changes that; only an independent oracle
would (a second, differently-written parser; or the real application
actually opening the drive). That's a real limit, not a gap to code
around, and it's worth being honest about rather than implying this
tool can fully replace an eyes-on check with real Serato/hardware.

**But within that ceiling, this specific check was weaker than it
should have been -- and now isn't.** Re-reading `verifyBurn`
(`packages/core/src/serato/burnToFlash.ts`) while answering James's
question found it compared `missingTrackIds`/`unexpectedTrackIds` as
**flat, library-wide sets of track ids** -- "does this track exist
*somewhere* in the burned library." A bug that silently reassigned a
track from one crate to a different one wouldn't change that set at
all: the track still exists exactly once, library-wide, just under the
wrong crate. That is *precisely* James's "rolled up to the club and a
folder was missing" failure mode, and the check as it stood could not
have caught it -- it would have reported `ok: true`.

**Fix**: extracted the comparison into a new pure, exported function,
`diffTrackPlacement(expectedTree, actualTree)`, which groups track ids
by crate path on both sides and adds a third category alongside the
existing two: `misplacedTrackIds` -- a track that exists in the burned
library and was expected somewhere, just not under the crate it's
supposed to be in. `BurnVerification.ok` now requires this to be empty
too. Deliberately kept filesystem-free and separately exported (rather
than inlined in `verifyBurn`) specifically so the placement-comparison
logic itself can be unit-tested against hand-built trees without a real
burn -- 5 new tests in `burnToFlash.test.ts`, including the exact
swapped-crates scenario ("same two tracks, same total count, nothing
missing or extra library-wide, just under the wrong crate each") and a
"moved one folder level up" variant, confirming both are caught as
`misplaced`, not silently passed as `missing`/`unexpected` cancelling
each other out. `core` suite is now 87 tests (up from 82), all green,
clean typecheck, run in the same scratch checkout used to validate the
Rekordbox work above.

**What this doesn't solve, and what would go further**: this closes one
concrete, previously-real gap in self-verification -- it does not
provide independent, hardware-level proof. Discussed with James as
further options, not yet decided or built: (a) if he has the Rekordbox
or Serato desktop *software* anywhere, pointing it at a burned volume
is a far cheaper oracle than a physical CDJ and doesn't require a club
trip; (b) cross-validating a burned/exported drive against a second,
independently-written parser (e.g. `pyrekordbox` for the Rekordbox
side) that doesn't share this project's own reader's blind spots would
be the strongest available proof short of real hardware; (c) for
Rekordbox's still-undecided write side (task #22), the
template-modify-a-real-export approach already favored is inherently
lower-risk than generating a file from scratch for exactly this reason
-- it leaves the overwhelming majority of a real, hardware-proven file
untouched.

## 2026-09-10 — Rekordbox reader extended to playlist/crate hierarchy, validated against real hardware

Phase 5's "read side, playlists" slice (see docs/roadmap.md) — the natural
next step flagged when the flat-track reader shipped (2026-09-08 entry
below): `pdbReader.ts` read individual tracks but not how Rekordbox
actually organizes them.

**Validated against a second real export, from real CDJ/Rekordbox
hardware this time** — James connected a flash drive that had actually
been burned for and used on his Rekordbox setup (not just exported from
the desktop app), at `D:\PIONEER\rekordbox\export.pdb`: 3,549 tracks, 431
playlist/folder nodes, 4,037 track-in-playlist entries. Every decoded
folder and playlist name came back as real, readable text in a sensible
hierarchy — "Artists" containing named-artist subfolders, genre-style
folders like "Chill Trap House" and "Bass - Riddim" with real tracks
inside — not garbage, which is the same bar the original track-path
validation was held to. The drive also confirmed the `volumeRoot`
convention holds the same way it does for Serato: track paths are stored
as `/<top-level-folder>/...` (here, `/Open Decks/...`, since that's the
top-level folder name on this particular drive) relative to the parent of
`PIONEER`, not to `PIONEER` itself.

**Two new tables, same page/row mechanics as the tracks table.**
`playlist_tree` (table type 7) rows are a real parent-pointer hierarchy —
`parentId`/`id`/`sortOrder`/`isFolder`/`name` — unlike Serato's crates,
which fake nesting via `%%`-separated filenames with no actual parent
links. `playlist_entries` (table type 8) rows are just
`entryIndex`/`trackId`/`playlistId`, no strings, 12 bytes flat. Refactored
the page/row-walking loop that was previously inlined in
`parsePdbTracks` into a shared `walkTableRows` helper so all three tables
(tracks, playlist_tree, playlist_entries) go through the same address
math — the loop itself was already proven correct, this just stopped
duplicating it.

**A real format quirk, handled deliberately, not just noted:** Rekordbox's
own data model has no way to attach a track directly to a folder, so its
UI fakes it by creating a hidden child playlist literally named
`_FolderTracks` under any folder that has tracks dropped straight into
it — confirmed on the real export, where every folder with direct tracks
in the Rekordbox UI has exactly one. `buildCanonicalTreeFromPlaylists`
(new: `packages/core/src/rekordbox/canonicalTree.ts`, the Rekordbox
counterpart to `serato/crateDatabaseReader.ts`) folds a `_FolderTracks`
child's tracks into its parent folder node and drops the node itself,
rather than surfacing Rekordbox's internal implementation detail as a
visible subfolder — this is a judgment call the format doesn't state
outright, flagged here in case an export shaped differently than the one
this was checked against ever disagrees with it. Same multi-membership
caveat as Serato crates applies: a track in more than one playlist stays
in every one of them, no single "owning" node is chosen.

**`playlist_entries` rows carry no validity marker** (unlike track rows'
required subtype, or playlist_tree rows' implicit validation via a
decodable name) — so a bogus row can't be rejected at parse time. Handled
one layer up instead: `buildCanonicalTreeFromPlaylists` drops any entry
whose `trackId` or `playlistId` doesn't match a real row from this same
export, and counts them (`orphanedEntryCount`) rather than trusting or
crashing on them. 0 on the real export used to validate this.

**Verified two ways before being called done, not just unit-tested:**
alongside the usual synthetic-buffer tests (`pdbReader.test.ts`, +5) and
plain-data join/hierarchy tests (`canonicalTree.test.ts`, new, 7 tests —
operating on typed arrays directly rather than binary, since this
function's job is reshaping already-parsed data, not decoding the format),
the actual compiled reader was run against the real 3,549-track export in
this session: 0 orphaned entries, all 4,037 entries placed in the tree, 0
`_FolderTracks` nodes leaking through as visible subfolders, and a spot
check (`Chill Trap House`) showing the right 44 tracks with correctly
resolved paths. `core`'s full suite — 82 tests, up from 70 — was run in
full (not just the new file) in a scratch checkout in this session, all
green, clean typecheck, so this is verified beyond the usual "James runs
it on his machine" step for once, on top of that step still happening
normally. Not yet wired into desktop IPC/UI — core-only, same pattern the
flat-track reader and the Serato readers before it followed.

Write-side strategy (task #22) is still open and untouched by this work —
see docs/roadmap.md's Phase 5 section.

## 2026-09-10 — Phase 3's UI flow wired up and verified (Phase 3's software side is now fully done)

The fourth and last of Phase 3's deliverables: a "Burn to flash" section
in the desktop app, alongside the existing scan/plan/execute controls.

**IPC additions**, following the exact shape every other channel in
this app already uses: `IPC_CHANNELS.diffBurn` ("burn:diff", read-only
preview) and `IPC_CHANNELS.burn` ("burn:execute", the real operation),
both taking a `BurnArgs` (`tree`, `targetRoot`, optional `mode`/
`excludedKeys`) and defined once in `shared/ipcContract.ts` so a mismatch
between main and renderer is a compile error on both sides, same as
everything else here.

**Where the Phase 3 content-hash cache actually lives, decided now that
it needed a real answer**: `registerIpc.ts` computes
`path.join(app.getPath('userData'), 'track-index.json')` once and passes
it into the two new handlers as a plain `storePath` argument -- the same
dependency-injection shape `onProgress` already uses for scan progress.
`ipcHandlers.ts` still imports zero Electron APIs; each `diffBurn`/`burn`
call loads a fresh `JsonTrackIndexStore` from that path and saves it back
at the end, rather than keeping one instance warm across calls. That's a
deliberate choice, not an oversight: a full load/parse is cheap at
personal-library scale (see the "Phase 3 design" entry), and it means
this file has no hidden module-level state a test would need to know to
reset -- every handler here is still just a plain function you can call
directly with real arguments, exactly like `__tests__/ipcHandlers.test.ts`
already does for scan/plan/execute.

**Selection is shared, not duplicated**: burning filters the tree through
the exact same `excludedKeys`/`filterTreeBySelection` path `planOrganize`
already used (pulled out into a small shared `applySelection` helper) --
unchecking a crate in the existing SelectionTree UI now leaves it out of
a burn too, rather than needing a second, separate "what to burn"
selection concept.

**UI**: a new "Burn to flash" card (gated on having scanned a library,
matching every other section on the page) with its own target-folder
field -- deliberately separate from the existing "Target root" field,
since burning writes a complete, standalone `_Serato_` structure onto a
drive, a different destination and a different operation from the local
canonical-tree copy the rest of the page does. "Preview burn" reports
new/changed/unchanged counts without writing anything; "Burn" does the
real thing and shows the verification result -- a plain warning, not a
crash, if `verification.ok` comes back false, telling James not to
disconnect the drive and pointing at the roadmap's failure-injection
notes rather than pretending everything's fine.

**How this got built, worth recording since it was unusual**: partway
through, this session's file bridge to James's machine lost its shell
(`device_bash`) -- folder listing, file staging, and file writing all
kept working, but the ability to actually *run* anything there did not.
Every file above was written and reviewed by hand against `@mlo/core`'s
real, already-tested API shapes (the same `diffAgainstDestination`/
`burnToFlash`/`JsonTrackIndexStore` signatures exercised by 70 passing
core tests) rather than iterated against a real typecheck/test run, and
committed to disk via the file-staging path instead of the usual shell.
**James ran `npm run typecheck` and `npm test` on his own machine
afterward and confirmed everything passes** -- so the code held up
without the usual tight edit/run loop, but that loop is still how this
project verifies itself; this was the exception, not a new normal.

## 2026-09-09 — Phase 3's burn-to-flash orchestrator, built and verified

The third of Phase 3's four deliverables: `packages/core/src/serato/burnToFlash.ts`,
composing everything built so far into the actual feature ("plug and
play on any Serato rig").

**`burnToFlash(tree, volumeRoot, { store })`** does, in order: diff the
source tree against `volumeRoot` → copy only `new`/`changed` tracks
(`allowOverwrite: true`, since a `changed` item here is already a
confirmed update, not an accidental collision — decision 18) →
regenerate the *entire* crate database at the target from the tree →
read the result back and verify it. Every burn rewrites every crate
file, even ones with no changed tracks underneath — crate files are
cheap, and doing this guarantees the crate structure can never quietly
drift from the canonical tree (a track that moved between crates, say),
even though audio files are only ever re-copied when they've actually
changed.

**A subtlety that would have been a real, silent data-loss bug if
missed**: `writeCrateDatabase` needs track paths relative to the
*destination* volume, but only a `new`/`changed` track was actually just
copied there this run -- an `unchanged` track already sits at the
destination from an earlier burn and was never touched. Feeding the
crate writer only the tracks that got copied this run would have made
every previously-burned, still-perfectly-fine track silently disappear
from the regenerated crates on every incremental burn, while its audio
file sat untouched on disk -- exactly the class of bug this whole
project is structured to catch before it's allowed near anything real.
Fixed by adding `treeAtDestination(tree, diff)` to `organizer/diff.ts`:
it rebuilds a tree with every track's path rewritten to its destination
location using the *full* diff (every item, not just what `planFromDiff`
kept), so the crate writer always sees the complete picture. Proven with
a dedicated test: burn once, add one new track, burn again -- the new
track is added *and* the original is still present in the regenerated
crate database, without being re-copied.

**Verification** reads the just-written crate database back with the
real reader and compares track ids as sets (not tree shape, which
sidesteps the empty-subtree round-trip quirk from decision 15 entirely)
against what was expected: `unresolvedCount` must be 0, nothing expected
should be missing, nothing unexpected should appear. A single `ok`
boolean is the one thing a caller needs to gate "did the burn actually
work" on, rather than trusting that no exception was thrown.

6 new tests in `__tests__/burnToFlash.test.ts`, covering: a first burn
from empty, a second burn with no changes (the critical
tracks-don't-vanish-from-crates case above), adding a track between
burns, a changed track being overwritten in place rather than renamed
aside, confirming the source tree itself is never mutated, and nested
crate hierarchies. Full `core` suite is now 70 tests, all green, clean
typecheck both packages.

**Minor, deliberate architectural note**: `organizer/diff.ts` now imports
`idForPath` from `serato/hash.ts` (needed by `treeAtDestination` to
compute a fresh id for a remapped track). `idForPath` is a plain
sha1-of-absolute-path helper with nothing Serato-specific about its
implementation -- it only lives under `serato/` today for historical
reasons. This is a small, working cross-module dependency, not a
mistake, and a candidate for a future cleanup (relocating it to `types/`)
rather than something worth pausing Phase 3 to fix now.

**Still open for Phase 3**: the UI flow (pick a target drive → preview →
burn → verification result), and everything gated on real hardware --
Phase 2's still-open manual USB checkpoint, a real burn to an actual
spare flash drive, and failure injection (drive unplugged mid-burn,
drive fills up mid-copy).

## 2026-09-09 — Phase 3, first two deliverables built: TrackIndexStore and diff-driven copying

Implements the design from the previous entry. Two pieces, plus a real
bug the diff work surfaced in already-shipped code.

**1. `packages/core/src/trackIndex/trackIndexStore.ts`**: `TrackIndexStore`
interface (`get`/`set`/`all`/`load`/`save`) and a `JsonTrackIndexStore`
implementation -- an atomically-written JSON file (temp file + rename)
mapping absolute path to `{ size, mtimeMs, contentHash, hashedAt }`. A
corrupted index file starts fresh rather than throwing, since it only
ever caches something recomputable -- never a source of real data.
`hashWithCache(store, absolutePath)` does the actual caching: stat first,
trust the cached hash only if size+mtime still match, otherwise re-hash
and update the cache. Deliberately takes a plain path rather than a
`TrackRef`, since the diff step below needs to hash files on the
destination side too, and those aren't tracks. 11 tests.

**2. `packages/core/src/organizer/diff.ts`**: `diffAgainstDestination(tree,
targetRoot, store)` reuses `planFromCanonicalTree` for every track's
expected target path (so the path-traversal safety check from decision
16 automatically covers this too), then classifies each as `new` /
`unchanged` / `changed` by comparing cached content hashes. No
`orphaned`/`deleted` status exists -- diffing is additive-only by design
(previous entry). `planFromDiff(diff)` turns that into a plan containing
only `new`/`changed` items; `summarizeDiff(diff)` gives the counts a UI
preview needs. 7 tests, including the actual end-to-end point of this
whole phase: **burning/copying twice in a row to the same destination
copies nothing the second time**, proven by running the real
diff -> plan -> execute pipeline twice against real files, not just
asserting on diff output in isolation.

**3. A real bug the end-to-end test surfaced in `executor.ts`, fixed on
the spot**: when a `changed` track's target path already had different
content, `executePlan` did exactly what it does for *any* content
mismatch -- renamed the new file alongside the old one
("track1 (2).mp3") rather than touching the existing file. That's the
right call for an accidental collision between two unrelated tracks
(the case the original design was solving for), but wrong for a
diff-confirmed update: the diff already established, by content hash
against that exact destination file, that this is the same track's slot
with different content now, not an unrelated collision. Left as-is, every
real edit to a track would pile up an ever-growing set of "(2)", "(3)"...
duplicates every time the library gets re-copied or re-burned --
defeating the entire point of diffing. **Fix**: `ExecuteOptions` gained
`allowOverwrite` (default `false`, so the ordinary ad hoc copy flow keeps
today's safe rename-aside behavior unchanged); when `true`, a genuine
content mismatch is overwritten in place instead of renamed, reported
under a new `overwritten` status. A target whose content already matches
the source is still always skipped either way -- `allowOverwrite` only
changes what happens on a *real* mismatch. Diff-driven execution (Phase
3's burn/re-copy orchestration, not yet built) is the intended caller;
covered by 2 new tests in `organizer.test.ts` plus the diff suite's
overwrite-in-place assertion. Full `core` suite is now 64 tests, all
green, clean typecheck both packages.

**Next**: the burn-to-flash orchestrator itself (diff -> plan ->
execute -> `writeCrateDatabase` -> read-back verification), still gated
on Phase 2's manual hardware checkpoint before it's trusted against a
real target. See `docs/roadmap.md`'s Phase 3 section.

## 2026-09-09 — Phase 3 design: content-hash identity, an index cache, and additive-only diffing

Planning pass for Phase 3 ("burn to flash"), before any code gets written.
Three design questions, decided together since they're one connected
piece of plumbing:

**1. Where does content-hash identity live?** `TrackRef.id` stays exactly
as it is today (a hash of the current path, used everywhere — planner,
executor, tests, the IPC contract) — changing what `id` *means* would
touch every one of those call sites for no real benefit. Content hash is
added as a new, separate concept instead, and — deliberately — it's
**not** a field the existing readers (`folderTreeReader`,
`crateDatabaseReader`, `pdbReader`) populate eagerly on every scan. A
plain scan today does zero file-content reads; forcing every scan to hash
every track's bytes just to fill in a field nobody asked for would make
ordinary scanning measurably slower for no benefit outside of Phase 3.
Instead, content hash is computed lazily, only by the diffing/burning
code path that actually needs it, and looked up by track rather than
carried on `TrackRef` itself.

**2. How is a computed hash remembered across runs, so re-scanning 5
years of music doesn't re-hash every file every time?** A new
`TrackIndexStore` interface (`get`/`set`/`all`/`load`/`save`) is the only
thing `core` code depends on — never a concrete storage format directly.
The first (and for now, only) implementation backing it is a plain JSON
file (`{ [absolutePath]: { size, mtimeMs, contentHash, hashedAt } }`),
written atomically (temp file + rename, so a crash mid-save can't corrupt
it). A cached hash is only trusted if the file's current `size` *and*
`mtime` still match what's recorded; if either changed, it's re-hashed —
the same cheap-stat-before-expensive-read trick git and rsync use.

Explicitly *not* SQLite, for now: at personal-library scale (tens of
thousands of tracks, not millions) a JSON index is fast enough that a
relational store would be solving a problem this project doesn't have,
and `better-sqlite3` is a native Node module — a genuinely new category
of Electron packaging/build risk for a project with zero native deps
today. The `TrackIndexStore` seam exists specifically so this can change
later without touching planner/executor code: if Phase 6 (duplicate
detection, a real library browser) ever needs actual relational queries
at real scale, a SQLite-backed implementation slots in behind the same
interface then — not before there's a real reason.

**3. What does diffing do when a track disappears from the source?**
Additive-only, never delete — matches the project's whole safety posture
so far (copy first, nothing destructive until proven). A file at a burn
destination that no longer has a matching source track is just left
alone; worst case is wasted disk space, never data loss. An explicit,
separately-designed "clean up orphans" step (previewed, confirmed) can be
added later once the diffing itself has been trusted for a while — it is
*not* part of Phase 3's initial scope.

### Concrete shape this gives Phase 3

- `packages/core/src/trackIndex/` — `TrackIndexEntry`, `TrackIndexStore`,
  `JsonTrackIndexStore`, and `hashWithCache(store, track)` (stat → compare
  against cache → reuse or recompute → update cache).
- A diff step — compares the canonical source tree against what
  `readFolderTree` finds already sitting at a destination (burn target,
  or the ordinary copy-to-canonical-tree target — this generalizes to
  both, per the 2026-09-08 roadmap note below), classifying every source
  track as `new`, `unchanged`, or `changed`, using cached content hashes
  on both sides. Only `new`/`changed` items become plan items — this is
  the actual payoff: re-burning (or re-copying to an already-organized
  target) copies nothing that hasn't actually changed.
- A burn-to-flash orchestrator that composes diff → plan → execute copies
  → `writeCrateDatabase` (already built, Phase 2) → a verification pass
  (read the result back with the real reader, diff against source). This
  is also where Phase 2's still-open manual hardware checkpoint finally
  gets exercised for real, since burning is the first place the writer
  gets used for something real rather than a round-trip test.

Testing this needs, once built: index-store cache-hit/cache-miss
round-trip tests; diff classification against hand-built trees (new/
unchanged/changed, plus the already-known empty-subtree quirk from
decision 15); an integration test proving a second burn against the same
destination copies nothing; then the real-hardware and failure-injection
testing already scoped in `docs/roadmap.md`'s Phase 3 section.


## 2026-09-08 — Path-traversal audit: a real, currently-shipped vulnerability found and closed

James asked for one last edge-case pass specifically for things that
could corrupt files or paths, before moving on. It found something real,
and it wasn't in the new crate writer -- it was in `planner.ts`, code
that's been shipping since Phase 0.

**The actual attack**: `readCrateDatabase` builds a tree's folder
structure by splitting a `.crate` FILENAME on `%%`
(`segmentsFromCrateFilename`), with no validation of what falls out the
other side. A file literally named `..%%Evil.crate` parses into segments
`["..", "Evil"]`. `planFromCanonicalTree` then built target paths with
plain `path.join(targetRoot, ...segments, filename)` and never checked
the result stayed under `targetRoot` -- so that one file would silently
plan a copy to a path *outside* the folder James chose as his target
root. `readFolderTree` can't produce this (folder names come straight
from `fs.readdir`, which never returns `..` or a separator as an entry
name), but `readCrateDatabase` treats a filename as untrusted text, and
nothing downstream was checking it. A corrupted, renamed, or hostile
`.crate` file dropped into `Subcrates` was a real path to writing
somewhere the user never asked for.

**Fix**: `planFromCanonicalTree` now computes each target path and
verifies it's still inside the resolved target root (`path.relative`
doesn't start with `..` and isn't absolute) before adding it to the
plan, and throws a clear, descriptive error otherwise. This is the
single defense point regardless of *what* produced the bad segment --
today's `%%`-filename parsing, a hand-built tree, or whatever builds
trees next (a Rekordbox importer, say). Proven end-to-end in
`__tests__/planner.test.ts`, including writing a real `..%%Evil.crate`
file, reading it with the actual reader, and confirming the plan step
refuses it rather than producing an escaping path.

**Two related hardening passes on `crateDatabaseWriter.ts` while the
same class of bug was fresh**:
- The existing `%%`-in-a-name guard was extended to also reject a
  segment containing a path separator (`/` or `\`) or being exactly `.`
  or `..` -- the writer's own mirror of the same risk, since it also
  builds a filesystem path (the `.crate` file's own location) by joining
  segments together, plus a general `assertStaysUnderRoot` check on the
  final path as a catch-all.
- Added a defense-in-depth check against two different tree nodes
  colliding on the same `.crate` filename (which would silently
  overwrite one with the other) -- can't happen from either existing
  reader today (both prevent duplicate sibling names structurally), but
  the writer shouldn't rely on that being true forever, especially once
  more tree-producing code exists.

All new behavior is covered by tests, not just described: 5 new tests in
`planner.test.ts`, 3 new tests in `crateDatabaseWriter.test.ts`. Full
`core` suite is now 44 tests, all green; clean typecheck on both
packages.

## 2026-09-08 — Property-based round-trip testing for the crate writer (Phase 2, software side closed)

Added `packages/core/__tests__/crateDatabaseWriter.property.test.ts`
using `fast-check`: instead of hand-picked fixtures, it generates many
random two-level tree shapes (varying branching, track counts per node,
and a track shared across a random number of crates) and asserts the
same round-trip property holds for every one -- write, read back with
the trusted reader, identical shape. 40 + 25 random cases per run, all
passing.

**It found something real on the very first run** (not a bug, a
specification gap in how I'd been thinking about this): a node with no
tracks anywhere in its own subtree -- not just directly on it, but on
every descendant too -- writes no `.crate` file at all, and so doesn't
come back on read-back. This is different from the "empty intermediate
folder" case the hand-picked suite already covered (an empty folder with
a non-empty *child*, which still gets synthesized because the child's
crate file implies it exists). A *fully* empty subtree leaves nothing
anywhere that could imply it exists. This isn't fixable -- Serato's
format has no file that represents a wholly empty folder, since the
folder concept is 100% inferred from `%%`-prefixes of files that
actually exist -- so it's now documented directly in
`crateDatabaseWriter.ts`'s module doc as a real round-trip limitation,
with a flag for Phase 3: whatever ends up computing an incremental
"what's new since the last burn" diff needs to know that fully-empty
branches silently disappear, or it'll misread that as data loss.

This closes the software side of Phase 2 exactly as scoped in
`docs/roadmap.md`: writer + hand-picked round-trip suite + property-based
round-trip suite are all done. **The one thing still open is the manual
checkpoint** -- write to a real scratch flash drive, open in actual
Serato, confirm by eye -- and it's genuinely blocked on hardware right
now (James doesn't have a spare USB on hand). Explicitly not treating
that as a reason to stop other work: it's deferred, not abandoned, and
nothing downstream (Phase 3, "burn to flash") gets built as if the
writer were hardware-validated until that checkpoint actually happens.

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
