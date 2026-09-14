import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DATABASE_V2_FILENAME, writeDatabaseV2 } from '@mlo/core';
import {
  burn,
  detectSeratoSource,
  diffBurn,
  executeOrganize,
  planOrganize,
  scanCrateDatabase,
  scanFolderTree,
} from '../src/main/ipcHandlers';

/**
 * These test the plain handler functions directly — no Electron runtime
 * involved, same as testing any other Node module. `registerIpc.ts` (the
 * thin ipcMain.handle wiring) is intentionally left untested here since it
 * has no logic of its own to break; it's covered by actually running the
 * app. This mirrors the old server/__tests__/app.test.ts, minus supertest
 * and minus the HTTP layer entirely.
 */
async function makeTmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('ipcHandlers', () => {
  let sourceRoot: string;
  let targetRoot: string;

  beforeEach(async () => {
    sourceRoot = await makeTmpDir('mlo-ipc-source-');
    targetRoot = await makeTmpDir('mlo-ipc-target-');
    await fs.mkdir(path.join(sourceRoot, 'House'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'House', 'track1.mp3'), 'content-1');
  });

  afterEach(async () => {
    await fs.rm(sourceRoot, { recursive: true, force: true });
    await fs.rm(targetRoot, { recursive: true, force: true });
  });

  it('detects a plain folder-tree library', async () => {
    const result = await detectSeratoSource(sourceRoot);
    expect(result.sourceType).toBe('serato-folders');
  });

  it('scans a folder tree into a canonical tree', async () => {
    const tree = await scanFolderTree(sourceRoot);
    expect(tree.root.children[0].name).toBe('House');
  });

  it('scans a crate database into a canonical tree', async () => {
    const subcratesDir = path.join(sourceRoot, '_Serato_', 'Subcrates');
    await fs.mkdir(subcratesDir, { recursive: true });
    await fs.writeFile(
      path.join(subcratesDir, 'House.crate'),
      buildFakeCrate(['House/track1.mp3'])
    );

    const tree = await scanCrateDatabase({ subcratesDir, volumeRoot: sourceRoot });
    expect(tree.root.children[0].name).toBe('House');
    expect(tree.root.children[0].tracks[0].filename).toBe('track1.mp3');
  });

  it('forwards scan progress through the optional onProgress callback', async () => {
    const events: unknown[] = [];
    await scanFolderTree(sourceRoot, (p: unknown) => events.push(p));
    expect(events.length).toBeGreaterThan(0);
  });

  it('planOrganize excludes deselected nodes when excludedKeys is given', async () => {
    await fs.mkdir(path.join(sourceRoot, 'Techno'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'Techno', 'track2.mp3'), 'content-2');

    const tree = await scanFolderTree(sourceRoot);
    const fullPlan = await planOrganize({ tree, targetRoot, mode: 'copy' });
    expect(fullPlan.items).toHaveLength(2);

    const filteredPlan = await planOrganize({ tree, targetRoot, mode: 'copy', excludedKeys: ['Techno'] });
    expect(filteredPlan.items).toHaveLength(1);
    expect(filteredPlan.items[0].sourcePath).toContain('House');
  });

  it('runs the full scan -> plan -> execute flow without any HTTP layer', async () => {
    const tree = await scanFolderTree(sourceRoot);
    const plan = await planOrganize({ tree, targetRoot, mode: 'copy' });
    expect(plan.items).toHaveLength(1);

    const report = await executeOrganize({ plan, dryRun: false });
    expect(report.summary.copied).toBe(1);

    const copied = await fs.readFile(path.join(targetRoot, 'House', 'track1.mp3'), 'utf8');
    expect(copied).toBe('content-1');
  });
});

/**
 * diffBurn/burn (Phase 3, docs/roadmap.md). Both take a `storePath` the
 * same way scanFolderTree/scanCrateDatabase take an optional onProgress
 * -- a plain, explicit parameter rather than reaching into Electron's
 * app.getPath() themselves, so these stay ordinary functions a test can
 * call directly with a real tmp file, no Electron runtime involved.
 */
describe('diffBurn / burn', () => {
  let sourceRoot: string;
  let burnTarget: string;
  let storePath: string;

  beforeEach(async () => {
    sourceRoot = await makeTmpDir('mlo-ipc-burn-source-');
    burnTarget = await makeTmpDir('mlo-ipc-burn-target-');
    const storeDir = await makeTmpDir('mlo-ipc-burn-index-');
    storePath = path.join(storeDir, 'index.json');
    await fs.mkdir(path.join(sourceRoot, 'House'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'House', 'track1.mp3'), 'content-1');
  });

  afterEach(async () => {
    await fs.rm(sourceRoot, { recursive: true, force: true });
    await fs.rm(burnTarget, { recursive: true, force: true });
  });

  it('diffBurn reports what would happen without writing anything', async () => {
    const tree = await scanFolderTree(sourceRoot);
    const summary = await diffBurn({ tree, targetRoot: burnTarget }, storePath);

    expect(summary).toEqual({ new: 1, unchanged: 0, changed: 0 });
    const targetExists = await fs
      .access(path.join(burnTarget, 'House', 'track1.mp3'))
      .then(() => true, () => false);
    expect(targetExists).toBe(false);
  });

  it('burn copies the audio and writes a crate database that verifies clean', async () => {
    const tree = await scanFolderTree(sourceRoot);
    const report = await burn({ tree, targetRoot: burnTarget }, storePath);

    expect(report.organizeReport.summary.copied).toBe(1);
    expect(report.verification.ok).toBe(true);

    const copied = await fs.readFile(path.join(burnTarget, 'House', 'track1.mp3'), 'utf8');
    expect(copied).toBe('content-1');
    const crateFiles = await fs.readdir(path.join(burnTarget, '_Serato_', 'Subcrates'));
    expect(crateFiles).toContain('House.crate');
  });

  it('a second burn with no source changes copies nothing but still verifies clean', async () => {
    const tree = await scanFolderTree(sourceRoot);
    await burn({ tree, targetRoot: burnTarget }, storePath);

    const secondReport = await burn({ tree, targetRoot: burnTarget }, storePath);
    expect(secondReport.organizeReport.summary.copied).toBe(0);
    expect(secondReport.diffSummary).toEqual({ new: 0, unchanged: 1, changed: 0 });
    expect(secondReport.verification.ok).toBe(true);
  });

  it('burn respects excludedKeys the same way planOrganize does', async () => {
    await fs.mkdir(path.join(sourceRoot, 'Techno'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'Techno', 'track2.mp3'), 'content-2');

    const tree = await scanFolderTree(sourceRoot);
    const report = await burn({ tree, targetRoot: burnTarget, excludedKeys: ['Techno'] }, storePath);

    expect(report.organizeReport.summary.copied).toBe(1);
    const technoExists = await fs
      .access(path.join(burnTarget, 'Techno', 'track2.mp3'))
      .then(() => true, () => false);
    expect(technoExists).toBe(false);
    const crateFiles = await fs.readdir(path.join(burnTarget, '_Serato_', 'Subcrates'));
    expect(crateFiles).not.toContain('Techno.crate');
  });

  /**
   * Phase 3b UI wiring (docs/decisions.md, 2026-09-14): `burn`'s
   * `sourceDatabaseV2` handling has three distinct behaviors worth
   * testing separately -- an explicit value is trusted as-is (and echoed
   * back on the report); an omitted one falls back to whatever
   * `defaultSourceDatabaseV2` is passed in, but only when that file
   * actually exists; and an omitted one with no real default present
   * must never turn into a burn failure.
   *
   * `defaultSourceDatabaseV2` is deliberately passed as an explicit
   * argument in every test here rather than left to `burn`'s own default
   * (the real `DEFAULT_SOURCE_DATABASE_V2`, a hardcoded path on James's
   * actual machine) -- an earlier version of this suite skipped that
   * parameter and asserted the *absence* of a default, which happened to
   * pass in this session's Linux sandbox (no `E:\` drive) and failed the
   * moment James ran it for real on the machine where that exact backup
   * lives. Building a real, controlled fixture per test is what makes
   * these deterministic on any machine, including his.
   */
  it('burn carries an explicit sourceDatabaseV2 forward and reports which one was used', async () => {
    const tree = await scanFolderTree(sourceRoot);

    // A fixture "already-analyzed" database describing the very same
    // track under sourceRoot -- realistic in shape, since a real
    // already-analyzed database and the library it analyzed live on the
    // same volume (e.g. James's live E:\_Serato_ describing tracks under
    // E:\). volumeRoot here is deliberately sourceRoot, not burnTarget --
    // this file's paths resolve against the SOURCE library, matching
    // DatabaseV2Source's own doc in @mlo/core.
    const analyzedDir = await makeTmpDir('mlo-ipc-analyzed-');
    const analyzedSeratoDir = path.join(analyzedDir, '_Serato_');
    await writeDatabaseV2(tree, analyzedSeratoDir, { volumeRoot: sourceRoot });
    const sourceDatabaseV2 = {
      filePath: path.join(analyzedSeratoDir, DATABASE_V2_FILENAME),
      volumeRoot: sourceRoot,
    };
    // A different, unrelated default -- proves the explicit value wins
    // over it rather than merely proving a default was never checked.
    const unusedDefault = {
      filePath: path.join(sourceRoot, 'nonexistent-default', DATABASE_V2_FILENAME),
      volumeRoot: sourceRoot,
    };

    const report = await burn({ tree, targetRoot: burnTarget, sourceDatabaseV2 }, storePath, unusedDefault);

    expect(report.databaseV2).toMatchObject({ written: true, trackCount: 1, preservedCount: 1 });
    expect(report.sourceDatabaseV2Used).toEqual(sourceDatabaseV2);

    await fs.rm(analyzedDir, { recursive: true, force: true });
  });

  it('burn applies the default sourceDatabaseV2 when the caller omits one and the default file exists', async () => {
    const tree = await scanFolderTree(sourceRoot);

    // Same fixture-building approach as the explicit-value test above,
    // but passed as the *default* (3rd arg) instead of on `args` --
    // proves resolveSourceDatabaseV2 actually checks for and uses a real
    // default file, not just that it tolerates a missing one.
    const analyzedDir = await makeTmpDir('mlo-ipc-analyzed-');
    const analyzedSeratoDir = path.join(analyzedDir, '_Serato_');
    await writeDatabaseV2(tree, analyzedSeratoDir, { volumeRoot: sourceRoot });
    const realDefault = {
      filePath: path.join(analyzedSeratoDir, DATABASE_V2_FILENAME),
      volumeRoot: sourceRoot,
    };

    const report = await burn({ tree, targetRoot: burnTarget }, storePath, realDefault);

    expect(report.databaseV2).toMatchObject({ written: true, trackCount: 1, preservedCount: 1 });
    expect(report.sourceDatabaseV2Used).toEqual(realDefault);

    await fs.rm(analyzedDir, { recursive: true, force: true });
  });

  it('burn falls back to minimal synthesis, without failing, when sourceDatabaseV2 is omitted and the default file does not exist', async () => {
    const tree = await scanFolderTree(sourceRoot);

    // A default that deliberately points nowhere real -- this is the
    // "fresh checkout, or the backup folder got moved" case, and it must
    // degrade gracefully rather than fail the burn.
    const missingDefault = {
      filePath: path.join(sourceRoot, 'nonexistent-default', DATABASE_V2_FILENAME),
      volumeRoot: sourceRoot,
    };

    const report = await burn({ tree, targetRoot: burnTarget }, storePath, missingDefault);

    expect(report.databaseV2).toMatchObject({ written: true, trackCount: 1, preservedCount: 0 });
    expect(report.sourceDatabaseV2Used).toBeNull();
  });

  it('burn fails loudly when an explicit sourceDatabaseV2 path does not exist (unlike the default)', async () => {
    const tree = await scanFolderTree(sourceRoot);

    await expect(
      burn(
        {
          tree,
          targetRoot: burnTarget,
          sourceDatabaseV2: {
            filePath: path.join(sourceRoot, 'nonexistent', DATABASE_V2_FILENAME),
            volumeRoot: sourceRoot,
          },
        },
        storePath
      )
    ).rejects.toThrow();
  });
});

function buildFakeCrate(trackPaths: string[]): Buffer {
  return Buffer.concat(trackPaths.map((p) => tlv('otrk', tlv('ptrk', encodeUtf16BE(p)))));
}

function tlv(tag: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(tag, 0, 'ascii');
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function encodeUtf16BE(str: string): Buffer {
  const le = Buffer.from(str, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i + 1 < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
}
