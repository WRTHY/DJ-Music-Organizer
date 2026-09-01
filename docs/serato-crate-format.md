# Serato crate format

Serato has never publicly documented its crate file format. Everything in
`packages/core/src/serato/crateDatabaseReader.ts` started as a **best-effort
implementation based on widely-circulated community reverse-engineering**
(the same shape of format referenced by several open-source projects that
read Serato libraries).

**Update, 2026-09-01**: validated against James's real library (a
`_Serato_` folder on a flash drive at `E:\_Serato_`). Confirmed by parsing
real `.crate` files directly:

- The container format (4-byte ASCII tag + 4-byte big-endian length +
  payload) is exactly right — a real file starts with a `vrsn` chunk whose
  UTF-16BE payload is literally `1.0/Serato ScratchLive Crate`.
- `otrk` chunks containing a nested `ptrk` chunk for the track path is
  exactly right.
- UTF-16BE text encoding is exactly right.
- The `%%`-separated filename hierarchy is exactly right — real examples
  include `Artists%%Lost Frequencies.crate` and four-levels-deep names
  like `Wedding%%Jearles%%Jearles - All Songs%%Jearles - Actual EDM.crate`.
- Track paths are relative, with **no drive letter and forward slashes**,
  e.g. `New Music/_2024/Trance/001 - Above & Beyond - Crazy Love.mp3` —
  and they resolve against the **parent of `_Serato_`**, not `_Serato_`
  itself (so `volumeRoot` here is `E:\`, confirmed by that folder existing
  on disk).
- This also confirms the original problem statement directly: the crate
  hierarchy (`Artists%%Lost Frequencies%%...`) is completely decoupled
  from the real folder the file lives in (`New Music/_2024/Trance/...`,
  an inbox-style folder named by year/rough batch). The deliberate
  curation lives entirely in the crate database — there's no "real
  folders" component to this library's organization scheme, so
  `folderTreeReader.ts` isn't the relevant reader for James's Serato
  structure. It stays in the codebase as a fallback for anyone whose
  Serato structure genuinely is real folders.

## What's implemented, and the assumption behind it

- **Container format**: the file is a flat sequence of chunks — a 4-byte
  ASCII tag, a 4-byte big-endian length, then that many bytes of payload.
  Some chunks (like `otrk`, a track entry) contain another sequence of
  chunks in the same shape, nested one level deep.
- **Text fields** (e.g. the file path inside a track entry) are assumed to
  be UTF-16BE.
- **Track paths**: each track entry (`otrk`) is assumed to contain a `ptrk`
  chunk holding the file's path, relative to the volume the crate lives on
  — not an absolute path. This needs confirmation: it may be relative to a
  different root than expected, or absolute in some Serato versions.
- **Hierarchy from filenames**: subcrate files under `_Serato_/Subcrates/`
  are assumed to encode their position in the crate tree in the filename
  itself, using `%%` as a separator (e.g. `House%%Deep House.crate` for a
  "Deep House" crate nested under "House"). Top-level crates would then
  just be `<Name>.crate` with no `%%`.

## Multi-crate membership — resolved

Serato crates are non-exclusive — a track can sit in a genre crate, an
artist crate, and a gig-prep crate all at once. The rule (James,
2026-09-01): **one crate = one folder, no exceptions, no classification.**
Every crate becomes a folder (via its `%%`-hierarchy), full stop. If a
track belongs to several crates, it gets copied into every one of those
folders — no attempt to pick a single "canonical" home. This needs no
special handling in `crateDatabaseReader.ts` or `planner.ts`: both already
treat each crate independently, so a track referenced by two crate files
naturally produces two plan items with the same source and two different
targets. See `__tests__/crateOrganizer.test.ts` for the proof.

## What's still open

- Behavior across Serato versions — the format isn't guaranteed to be
  stable release to release; this was only checked against one library's
  current version.
- Chunk types other than `otrk`/`ptrk` (e.g. `osrt`, `ovct` — sort order
  and column-view config) are parsed but intentionally ignored; they're
  crate-UI metadata, not track placement.
