# Music Library Organizer

A desktop app for keeping a DJ music library organized across **Serato**
and **Rekordbox** without either one being the sole source of truth.

## The problem

New music lands in an inbox folder, then gets manually sorted into subcrates
in Serato. That sorting only exists inside Serato's crate database —
decoupled from where the files physically sit (confirmed against a real
library, see [`docs/serato-crate-format.md`](docs/serato-crate-format.md))
— so there is no single, portable folder structure that Rekordbox (or
anything else) can just point at.

## What this does (v0)

1. Reads the current Serato crate organization and represents it as a
   tool-agnostic **canonical tree** — one crate, one folder, always (a
   track in several crates ends up copied into all of them; see
   [`docs/decisions.md`](docs/decisions.md)).
2. Copies files from wherever they currently live into a new folder tree
   that mirrors that canonical structure, under a target root you choose.
   Copy is the default; move is a planned follow-up once the mapping logic
   has proven itself.
3. Ships as an **Electron desktop app** — a native folder picker instead of
   typing paths, one installer to hand to a friend, no separate server to
   run — while doubling as a full-stack + QA/SDET portfolio piece with real
   test automation against it.

## Project layout

```
packages/
  core/     canonical data model, Serato readers, organizer (plan + execute)
            — plain Node/TypeScript, no Electron dependency
  desktop/  the app itself (Electron + React, via electron-vite)
    src/main/      main process — window lifecycle, IPC handlers, uses core
    src/preload/   contextBridge security boundary exposed as window.mlo
    src/renderer/  the React UI
    src/shared/    the IPC contract (channel names + types) both sides import
docs/       architecture notes, decisions, format notes
```

## Status

`core`: folder-tree reader, a crate-database reader validated against a
real Serato library, and a copy-first organizer with dry-run and conflict
handling — all covered by unit tests. `desktop`: a working Electron app
(main + preload + renderer all build and type-check; IPC handlers are
unit-tested) with a functional UI for scanning, previewing, dry-running,
and executing an organize pass. Not yet packaged into an installer or
covered by real UI-driving e2e tests — see [`docs/decisions.md`](docs/decisions.md)
for what's next.

## Running locally

```bash
npm install
npm run build
npm run dev:desktop   # launches the Electron app with hot reload
```

To build an installer (unsigned — see `packages/desktop/electron-builder.yml`):

```bash
npm run dist:desktop
```

## Running tests

```bash
npm test
```
