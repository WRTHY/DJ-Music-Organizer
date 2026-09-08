import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * First real end-to-end test for the desktop app (Phase 1 of
 * docs/roadmap.md). Drives the actual built Electron app -- not a mock of
 * it -- through the whole scan -> plan -> dry run -> execute pipeline, in
 * folder-tree mode, against a small, checked-in synthetic library fixture
 * (e2e/fixtures/synthetic-library) -- never James's real E:\_Serato_.
 * Meant to run unattended in CI, same "prove it on scratch/synthetic data
 * first" discipline as the rest of this project.
 *
 * Requires the app to already be built (`npm run build`, i.e.
 * `electron-vite build`) -- this launches the compiled out/main/index.js,
 * not source. `npm run test:e2e` builds first automatically.
 */

const MAIN_ENTRY = path.join(__dirname, '..', 'out', 'main', 'index.js');
const FIXTURE_LIBRARY = path.join(__dirname, 'fixtures', 'synthetic-library');

// Mirrors the fixture tree under e2e/fixtures/synthetic-library -- kept in
// sync by hand since it's small and rarely changes. planFromCanonicalTree
// (packages/core/src/organizer/planner.ts) builds target paths as
// targetRoot/<folder segments>/<filename>, which is what these paths assume.
const EXPECTED_RELATIVE_PATHS = [
  '05 - Root Level Track.wav',
  path.join('Techno', '01 - Track One.mp3'),
  path.join('Techno', '02 - Track Two.mp3'),
  path.join('House', '03 - Track Three.mp3'),
  path.join('House', 'Deep', '04 - Track Four.mp3'),
];

test.describe('scan -> plan -> dry run -> execute (folder-tree mode)', () => {
  let electronApp: ElectronApplication;
  let window: Page;
  let targetRoot: string;

  test.beforeEach(async () => {
    if (!existsSync(MAIN_ENTRY)) {
      throw new Error(
        `Built app not found at ${MAIN_ENTRY} -- run "npm run build" (electron-vite build) before the e2e suite.`
      );
    }

    // A fresh scratch directory per run, outside the repo -- this is the
    // "target root" the app copies into, never a real library location.
    targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-e2e-target-'));

    electronApp = await electron.launch({ args: [MAIN_ENTRY] });

    // The renderer's "Browse..." buttons call dialog.showOpenDialog via
    // IPC, which opens a real native OS dialog outside Playwright's reach.
    // Stubbing it in the main process is the standard Playwright/Electron
    // pattern: each click resolves to the next path in this queue, in the
    // order the test triggers them (source folder, then target root).
    await electronApp.evaluate(({ dialog }, paths: string[]) => {
      let next = 0;
      dialog.showOpenDialog = async () => {
        const filePath = paths[Math.min(next, paths.length - 1)];
        next += 1;
        return { canceled: false, filePaths: [filePath] };
      };
    }, [FIXTURE_LIBRARY, targetRoot]);

    window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
  });

  test.afterEach(async () => {
    await electronApp?.close();
    await fs.rm(targetRoot, { recursive: true, force: true });
  });

  test('copies the synthetic library into a mirrored target tree', async () => {
    await window.getByRole('radio', { name: 'Real folders on disk' }).check();

    await window
      .locator('label', { hasText: 'Serato-managed root folder' })
      .getByRole('button', { name: 'Browse…' })
      .click();
    await window
      .locator('label', { hasText: 'Target root (canonical structure goes here)' })
      .getByRole('button', { name: 'Browse…' })
      .click();

    await window.getByRole('button', { name: 'Scan' }).click();
    await expect(window.getByText(/5 track\(s\) found/)).toBeVisible();

    await window.getByRole('button', { name: 'Preview plan (copy)' }).click();
    await expect(window.getByRole('heading', { name: /Plan preview \(5 file\(s\), mode: copy\)/ })).toBeVisible();

    await window.getByRole('button', { name: 'Dry run' }).click();
    await expect(window.getByRole('heading', { name: 'Dry run report' })).toBeVisible();
    await expect(window.getByText('copied: 5')).toBeVisible();

    // Dry run must not have touched the filesystem -- the actual
    // data-safety regression this suite exists to catch.
    for (const relPath of EXPECTED_RELATIVE_PATHS) {
      await expect(fs.access(path.join(targetRoot, relPath))).rejects.toThrow();
    }

    await window.getByRole('button', { name: 'Execute copy' }).click();
    await expect(window.getByRole('heading', { name: 'Execution report' })).toBeVisible();
    await expect(window.getByText('copied: 5')).toBeVisible();

    // Every file landed exactly where the canonical tree says it should,
    // mirroring the source folder structure under the target root.
    for (const relPath of EXPECTED_RELATIVE_PATHS) {
      await expect(fs.access(path.join(targetRoot, relPath))).resolves.toBeUndefined();
    }
  });
});
