# Decisions log

Lightweight ADR-style log of the choices behind this project. Newest first.

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

## Open questions / next decisions

- Decide the canonical target root's location (same flash drive? a new
  drive/folder both Serato and Rekordbox get pointed at?).
- Package a real installer (`electron-builder`) and actually install/run
  it on James's machine — the smoke test above proves the app boots, not
  that the full UI flow works end to end on real hardware.
- Real UI-driving e2e tests via Playwright's Electron support (`_electron`)
  — ties directly into James's existing Playwright/Electron testing
  experience, tracked as the next portfolio-relevant testing milestone.
- Decide track-identity strategy for future syncing (filename? content
  hash? tags?) once we're past "just copy the structure."
- Design the eventual Rekordbox side (Rekordbox's own database format is a
  separate reverse-engineering problem from Serato's).

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
