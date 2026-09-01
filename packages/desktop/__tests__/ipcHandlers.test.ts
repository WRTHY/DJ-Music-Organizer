import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  detectSeratoSource,
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
