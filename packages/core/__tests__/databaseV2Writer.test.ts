import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonicalNode, CanonicalTree, TrackRef, emptyNode } from '../src/types';
import { idForPath } from '../src/serato/hash';
import { readDatabaseV2 } from '../src/serato/databaseV2Reader';
import { writeDatabaseV2 } from '../src/serato/databaseV2Writer';

/**
 * Round-trip suite for the database V2 writer (Phase 3b Deliverable 3,
 * docs/roadmap.md): build a canonical tree by hand -> write it as a real
 * `database V2` file -> read it back with the already-trusted reader ->
 * assert the tracks match. Same trust-gate pattern
 * crateDatabaseWriter.test.ts established for Phase 2.
 */

function track(sourcePath: string): TrackRef {
  return {
    id: idForPath(sourcePath),
    sourcePath,
    filename: path.basename(sourcePath),
    ext: path.extname(sourcePath).toLowerCase(),
  };
}

function node(name: string, segments: string[], tracks: TrackRef[] = [], children: CanonicalNode[] = []): CanonicalNode {
  return { ...emptyNode(name, segments), tracks, children };
}

describe('writeDatabaseV2 (round-trip against the trusted reader)', () => {
  let volumeRoot: string;
  let seratoDir: string;

  beforeEach(async () => {
    volumeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-dbv2-write-volume-'));
    seratoDir = path.join(volumeRoot, '_Serato_');
  });

  afterEach(async () => {
    await fs.rm(volumeRoot, { recursive: true, force: true });
  });

  it('writes one otrk per unique track, including root-level (uncrated) tracks', async () => {
    const rootTrack = track(path.join(volumeRoot, 'Inbox', 'loose-track.mp3'));
    const houseTrack = track(path.join(volumeRoot, 'Inbox', '01 - Track One.wav'));
    const deepHouseTrack = track(path.join(volumeRoot, 'Inbox', '02 - Track Two.mp3'));

    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: node('', [], [rootTrack], [
        node('House', ['House'], [houseTrack], [
          node('Deep House', ['House', 'Deep House'], [deepHouseTrack]),
        ]),
      ]),
    };

    const result = await writeDatabaseV2(tree, seratoDir, { volumeRoot });

    expect(result.filePath).toBe(path.join(seratoDir, 'database V2'));
    expect(result.trackCount).toBe(3); // root-level track included, unlike the crate writer

    const readBack = await readDatabaseV2(result.filePath);
    expect(readBack.versionString).toBe('2.0/Serato Scratch LIVE Database');
    expect(readBack.tracks).toHaveLength(3);

    const byPath = new Map(readBack.tracks.map((t) => [t.rawPath, t]));
    expect(byPath.get('Inbox/loose-track.mp3')).toMatchObject({ fileType: 'mp3' });
    expect(byPath.get('Inbox/01 - Track One.wav')).toMatchObject({ fileType: 'wav' });
    expect(byPath.get('Inbox/02 - Track Two.mp3')).toMatchObject({ fileType: 'mp3' });
  });

  it('deduplicates a track referenced from multiple crates into exactly one entry', async () => {
    const sharedTrack = track(path.join(volumeRoot, 'Inbox', 'shared.mp3'));

    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: node('', [], [], [
        node('House', ['House'], [sharedTrack]),
        node('Favorites', ['Favorites'], [sharedTrack]),
      ]),
    };

    const result = await writeDatabaseV2(tree, seratoDir, { volumeRoot });
    expect(result.trackCount).toBe(1);

    const readBack = await readDatabaseV2(result.filePath);
    expect(readBack.tracks).toHaveLength(1);
    expect(readBack.tracks[0].rawPath).toBe('Inbox/shared.mp3');
  });

  it('writes a valid, empty (zero-track) database V2 rather than refusing', async () => {
    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: node('', []),
    };

    const result = await writeDatabaseV2(tree, seratoDir, { volumeRoot });
    expect(result.trackCount).toBe(0);

    const readBack = await readDatabaseV2(result.filePath);
    expect(readBack.versionString).toBe('2.0/Serato Scratch LIVE Database');
    expect(readBack.tracks).toEqual([]);
  });

  it('refuses to write when a database V2 file already exists at the target, rather than merging or overwriting', async () => {
    const t = track(path.join(volumeRoot, 'Inbox', 'track.mp3'));
    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: node('', [], [t]),
    };

    await writeDatabaseV2(tree, seratoDir, { volumeRoot });

    await expect(writeDatabaseV2(tree, seratoDir, { volumeRoot })).rejects.toThrow(
      /already exists/
    );
  });

  it('rejects a track whose source path is not under the given volume root', async () => {
    const outsideTrack = track(path.join(os.tmpdir(), 'somewhere-else', 'track.mp3'));
    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: node('', [], [], [node('Misc', ['Misc'], [outsideTrack])]),
    };

    await expect(writeDatabaseV2(tree, seratoDir, { volumeRoot })).rejects.toThrow(/volume root/);
  });
});
