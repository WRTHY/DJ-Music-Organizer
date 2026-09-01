# Design system

This project's UI follows the same visual language as James's portfolio
site (`_Portfolio/portfolio`), used here as a reference, not a dependency —
nothing is imported from it, the *patterns* are copied by hand. This
applies to everything built in `packages/desktop/src/renderer` going
forward, not just what exists today.

## Where it lives

- `src/renderer/src/styles/theme.css` — the token file. A `:root` block of
  CSS custom properties (colors, radii, spacing, fonts), imported once in
  `main.tsx`. Every component should reference these tokens, never hardcode
  a color or a `border-radius` value.
- `src/renderer/src/components/atoms/` — small, reusable pieces (`Button`,
  `Card`, more as they're needed) each as `Name.tsx` + `Name.module.css`.
- `src/renderer/src/components/molecules/` — atoms composed together for a
  specific job (`FolderField` = a label + text input + Browse button).
- `src/renderer/src/utils/classNames.ts` — the `cx()` helper for
  conditionally joining CSS Module class names.

This is the same atomic-design layout (atoms → molecules → organisms →
templates) the portfolio uses; `organisms`/`templates` don't exist yet
because the app isn't big enough to need them, but new components should
slot into this structure rather than living directly in `App.tsx`.

## The rules, carried over from the portfolio's `DESIGN.md`

- **One accent color.** `--accent` (violet) is the only saturated brand
  color. Status colors (`--danger`) are the deliberate exception — they
  signal state, not brand.
- **Three-radius rule.** `--radius-lg` (12px) for cards and panels,
  `--radius-sm` (4px) for buttons/inputs/chips, `--radius-pill` (999px) for
  anything that should read as a pill. No other radius values.
- **Light/dark for free.** Every color token uses CSS `light-dark()`, so
  the whole app follows the OS theme automatically with zero JS.
- **CSS Modules per component**, not a global stylesheet of one-off
  classes, and not inline `style={{...}}` props — `App.tsx` used to be full
  of the latter; the refactor that introduced this file replaced all of it.

## Where this project deliberately diverges from the portfolio

**Font: system stack, not the licensed custom font.** The portfolio's
headings use `TBJ-Orcherum`, a licensed font pulled from a private GitHub
repo at build time via a token (`scripts/fetch-fonts.mjs`). Reusing it here
would mean this project needs that same private-repo token to build at
all — a real dependency for something being shared with friends, not just
James. So `--heading` and `--sans` both resolve to the system font stack
(`system-ui, 'Segoe UI', Roboto, sans-serif`). Everything else — the color
tokens, the radius rule, the one-accent rule, the component patterns —
carried over as-is.

## Adding a new component

1. Reach for an existing token in `theme.css` before adding a new value.
   If nothing fits, add the token, not a one-off value.
2. New atom → `components/atoms/Name/Name.tsx` + `Name.module.css`. New
   molecule (a composition of atoms for one job) → same shape under
   `components/molecules/`.
3. Use `cx()` from `utils/classNames.ts` for conditional classes instead of
   template-string concatenation.
