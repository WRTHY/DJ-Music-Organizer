import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the desktop app's e2e suite (Phase 1 of
 * docs/roadmap.md). This drives the real, built Electron app via
 * Playwright's `_electron` support -- not a browser -- against a small,
 * checked-in synthetic library fixture under e2e/fixtures/. Never run
 * against James's real E:\_Serato_ library; that's manual/exploratory
 * testing, covered separately (see roadmap.md Phase 1).
 *
 * Requires `npm run build` (electron-vite build) first so out/main/
 * index.js exists -- `npm run test:e2e` does this for you.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // One Electron app instance at a time -- these tests aren't written to
  // run several real app windows concurrently.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
});
