import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonicalTree, TrackRef, emptyNode } from '../src/types';
import { planFromCanonicalTree } from '../src/organizer/planner';
import { readCrateDatabase } from '../src/serato/crateDatabaseReader';

/**
 * Path-safety edge cases for planFromCanonicalTree. organizer.test.ts
 * already covers the happy path (real folder trees, via readFolderTree,
 * plan correctly) -- this file covers the thing that reader can never
 * produce but readCrateDatabase can: a tree segment that is itself a
 * path-traversal component, because it came from splitting an untrusted
 * .crate FILENAME on "%%" rather than from a real filesystem entry name.
 */

function track(sourcePath: string): TrackRef {
  return {
    id: 'fake-id',
    sourcePath,
    filename: path.basename(sourcePath),
    ext: path.extname(sourcePath).toLowerCase(),
  };
}

describe('planFromCanonicalTree (path-safety)', () => {
  it('refuses to plan a copy for a hand-built tree with a ".." segment', () => {
    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: {
        ...emptyNode('', []),
        children: [
          {
            ...emptyNode('..', ['..']),
            children: [
              { ...emptyNode('Evil', ['..', 'Evil']), tracks: [track('/inbox/evil.mp3')] },
            ],
          },
        ],
      },
    };

    expect(() => planFromCanonicalTree(tree, '/target/root')).toThrow(/falls outside/);
  });

  it('refuses to plan a copy for a root-level track whose filename is itself a traversal', () => {
    // Deliberately at the tree ROOT (no folder segments to "absorb" the
    // ".." first) -- path.join(root, "House", "../evil.mp3") would
    // actually normalize back to root/evil.mp3, still inside root, so
    // this needs zero preceding segments to actually escape.
    const maliciousTrack: TrackRef = {
      id: 'fake-id',
      sourcePath: '/inbox/evil.mp3',
      filename: '../evil.mp3',
      ext: '.mp3',
    };
    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: { ...emptyNode('', []), tracks: [maliciousTrack] },
    };

    expect(() => planFromCanonicalTree(tree, '/target/root')).toThrow(/falls outside/);
  });

  it('refuses to plan a copy when enough ".." segments outweigh the real folder depth', () => {
    const maliciousTrack: TrackRef = {
      id: 'fake-id',
      sourcePath: '/inbox/evil.mp3',
      filename: '../../evil.mp3',
      ext: '.mp3',
    };
    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: {
        ...emptyNode('', []),
        children: [{ ...emptyNode('House', ['House']), tracks: [maliciousTrack] }],
      },
    };

    expect(() => planFromCanonicalTree(tree, '/target/root')).toThrow(/falls outside/);
  });

  it('still plans normal, well-formed trees without throwing (no false positives)', () => {
    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: {
        ...emptyNode('', []),
        children: [
          { ...emptyNode('House', ['House']), tracks: [track('/inbox/track1.mp3')] },
        ],
      },
    };

    const plan = planFromCanonicalTree(tree, '/target/root');
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].targetPath).toBe(path.join(path.resolve('/target/root'), 'House', 'track1.mp3'));
  });

  it('end-to-end: a maliciously/corruptly named ".crate" file cannot escape the target root', async () => {
    // The real attack this closes: readCrateDatabase happily parses a
    // filename like "..%%Evil.crate" into segments ["..", "Evil"] --
    // segmentsFromCrateFilename only splits on "%%", it doesn't validate
    // what falls out. Without the guard in planner.ts, this would plan a
    // copy to a path one directory above targetRoot.
    const volumeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-planner-volume-'));
    try {
      const subcratesDir = path.join(volumeRoot, '_Serato_', 'Subcrates');
      await fs.mkdir(subcratesDir, { recursive: true });
      await fs.mkdir(path.join(volumeRoot, 'Inbox'), { recursive: true });
      await fs.writeFile(path.join(volumeRoot, 'Inbox', 'evil.mp3'), 'x');

      const buf = (tag: string, payload: Buffer) => {
        const header = Buffer.alloc(8);
        header.write(tag, 0, 'ascii');
        header.writeUInt32BE(payload.length, 4);
        return Buffer.concat([header, payload]);
      };
      const utf16be = (s: string) => {
        const le = Buffer.from(s, 'utf16le');
        const be = Buffer.alloc(le.length);
        for (let i = 0; i + 1 < le.length; i += 2) {
          be[i] = le[i + 1];
          be[i + 1] = le[i];
        }
        return be;
      };
      const crateBuffer = buf('otrk', buf('ptrk', utf16be('Inbox/evil.mp3')));
      await fs.writeFile(path.join(subcratesDir, '..%%Evil.crate'), crateBuffer);

      const tree = await readCrateDatabase(subcratesDir, { volumeRoot });
      const targetRoot = path.join(volumeRoot, 'Canonical');

      expect(() => planFromCanonicalTree(tree, targetRoot)).toThrow(/falls outside/);
    } finally {
      await fs.rm(volumeRoot, { recursive: true, force: true });
    }
  });
});
