# Architecture (v0 → desktop)

```
 ┌─────────────────────────────────────────────────────────────────┐
 │ Electron app (one process tree, ships as one installer)          │
 │                                                                    │
 │  ┌──────────────────┐   contextBridge    ┌───────────────────┐   │
 │  │ renderer (React)  │◄──window.mlo──────►│ preload            │  │
 │  │ Chromium, NO Node │   (whitelisted)     │ contextIsolation:  │  │
 │  │ access            │                     │ true               │  │
 │  └──────────────────┘                     └─────────┬─────────┘  │
 │                                                       │ ipcRenderer│
 │                                                       │ .invoke   │
 │                                            ┌──────────▼─────────┐ │
 │                                            │ main process        │ │
 │                                            │ real Node, fs access│ │
 │                                            │ ipcMain.handle(...) │ │
 │                                            │ dialog.showOpenDialog│ │
 │                                            └──────────┬─────────┘ │
 └───────────────────────────────────────────────────────┼──────────┘
                                                            │ uses
                                                 ┌──────────▼───────────┐
                                                 │   core (library)      │
                                                 │  - canonical tree     │
                                                 │  - serato/ readers    │
                                                 │  - organizer/         │
                                                 └───────────────────────┘
```

## Core concepts (unchanged from the web-app version)

**Canonical tree** — a plain, tool-agnostic representation of a folder
hierarchy plus the tracks in each node:

```ts
CanonicalNode {
  name: string
  path: string[]        // segments from the root, e.g. ["House", "Deep House"]
  children: CanonicalNode[]
  tracks: TrackRef[]
}
```

No Serato-specific or Rekordbox-specific concepts leak into it. Both
readers (folder-tree, crate-database) produce the same shape; the
organizer only ever consumes a `CanonicalTree`.

**Plan / execute split** — `organizer/planner.ts` turns a canonical tree
plus a target root into an `OrganizePlan` (source → target operations)
without touching the filesystem. `organizer/executor.ts` performs it, with
`dryRun` support and per-file conflict handling. This is why the UI can
show a full preview before anything is written to disk — and it's also
exactly why `core` has zero Electron dependency: it doesn't need to know
whether it's being called from a web server, an Electron main process, or
a future CLI.

## What changed for the desktop app

**Process model.** Electron gives every window two processes: **main**
(real Node, one per app, has filesystem access) and **renderer** (the
Chromium page running the React UI, no Node access by default). They
can't call each other's functions directly — main registers
`ipcMain.handle('channel', fn)`, the renderer calls
`ipcRenderer.invoke('channel', args)` and awaits a promise. Structurally
this is the same request/response shape `fetch('/api/...')` had; the
actual logic in `src/main/ipcHandlers.ts` is almost a direct port of the
old Express route handlers.

**The preload script is the new piece.** `contextIsolation: true` +
`nodeIntegration: false` mean the renderer's JS runs in a context that
cannot see Node or raw `ipcRenderer`. `src/preload/index.ts` runs in a
separate, privileged context and uses `contextBridge.exposeInMainWorld`
to hand the renderer exactly one thing: `window.mlo`, a whitelisted object
of specific async functions (`window.mlo.scanCrateDatabase(...)`, etc.).
The renderer cannot invoke a channel that isn't explicitly exposed here,
no matter what code runs in the page — that's the security model, not
just a style choice.

**The IPC contract** (`src/shared/ipcContract.ts`) is the one file both
main and renderer depend on: channel name constants, and TypeScript types
for every call's arguments and return value. `registerIpc.ts` (main) and
`preload/index.ts` implement it; `renderer/src/api.ts` calls through it.
Change a type here and both sides break at compile time if they've
drifted — that's the payoff for the extra indirection.

**Package shape**: `desktop` replaces `server` + `web` as a single
package, following `electron-vite`'s convention (`src/main`,
`src/preload`, `src/renderer`), because — unlike a hosted web app's
frontend and backend — the renderer and main process always ship together
as one artifact. There's no independent-deploy reason to keep them in
separate packages once that's true; see `docs/decisions.md` for the fuller
version of this argument (it's the same one that answered "should backend
be a separate repo").

**Native dialogs.** `dialog.showOpenDialog` (main-process only) replaces
the old text-input-for-a-path UI, wired through its own IPC channel
(`dialog:selectFolder`).

## Testing strategy

- `core`: unchanged, plain Jest, zero Electron involved — still the
  most-tested layer.
- `desktop`'s IPC handlers (`src/main/ipcHandlers.ts`) are plain exported
  async functions with no `electron` import; `registerIpc.ts` is the only
  file that wires them to `ipcMain.handle`. That split means the handlers
  are unit-testable with ordinary Jest (`__tests__/ipcHandlers.test.ts`),
  same idea as the old Express integration tests, minus HTTP entirely.
- Real end-to-end (launching the actual packaged app, driving the real
  React UI) is a job for Playwright's official Electron support
  (`_electron`) — not built yet, tracked as follow-up work.

## Deliberately out of scope for v0

- Rekordbox's own database/export format — a separate problem, tackled
  once the Serato side is trustworthy.
- Code signing / notarization for the installer — an unsigned build
  triggers an OS warning on first run, acceptable for personal use and
  friends who know what they're installing.
- Audio tag reading (artist/title/BPM/etc.) — the canonical tree only
  carries filesystem-level info today.
