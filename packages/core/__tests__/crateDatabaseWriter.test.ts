import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonicalNode, CanonicalTree, TrackRef, emptyNode } from '../src/types';
import { idForPath } from '../src/serato/hash';
import { readCrateDatabase } from '../src/serato/crateDatabaseReader';
import { writeCrateDatabase } from '../src/serato/crateDatabaseWriter';

/**
 * Round-trip suite for the crate writer (Phase 2 of docs/roadmap.md):
 * build a canonical tree by hand -> write it as a real crate database ->
 * read it back with the already-trusted reader -> assert the shapes
 * match. This is the actual trust gate before the writer is allowed
 * anywhere near a scratch flash drive, let alone James's real
 * `E:\_Serato_` (see the module doc in crateDatabaseWriter.ts).
 *
 * Every track here points at a real (empty) placeholder file under a
 * temp volumeRoot, so the read-back pass also exercises the reader's
 * existence check (unresolvedCount) as a genuine end-to-end proof, not
 * just a structural one.
 */

/** Builds a TrackRef the same way a real reader would -- id/filename/ext
 * derived from the absolute sourcePath, matching idForPath exactly, so a
 * round trip can be asserted with real deep-equal rather than a looser
 * "same filenames" check. */
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

/** Order-independent shape of a tree, for comparing the original tree
 * against what comes back from the reader -- readCrateDatabase doesn't
 * sort crate files before processing (unlike the folder-tree reader), so
 * child/track order isn't guaranteed and shouldn't be asserted on. */
function shape(node: CanonicalNode): unknown {
  return {
    name: node.name,
    path: node.path,
    tracks: [...node.tracks].sort((a, b) => a.filename.localeCompare(b.filename)),
    children: [...node.children]
      .map(shape)
      .sort((a, b) => (a as { name: string }).name.localeCompare((b as { name: string }).name)),
  };
}

async function touch(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, '');
}

describe('writeCrateDatabase (round-trip against the trusted reader)', () => {
  let volumeRoot: string;
  let subcratesDir: string;

  beforeEach(async () => {
    volumeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-write-volume-'));
    subcratesDir = path.join(volumeRoot, '_Serato_', 'Subcrates');
  });

  afterEach(async () => {
    await fs.rm(volumeRoot, { recursive: true, force: true });
  });

  it('round-trips nested crates, unicode names, an empty intermediate folder, and a track in two crates', async () => {
    const houseTrack1 = track(path.join(volumeRoot, 'Inbox', '01 - Track One.mp3'));
    const deepHouseTrack = track(path.join(volumeRoot, 'Inbox', '02 - Track Two.mp3'));
    // Unicode: a folder name with an accent + a non-Latin filename.
    const chillTrack = track(path.join(volumeRoot, 'Inbox', '03 - Björk - Jóga.mp3'));
    // The same physical file, referenced from two different crates.
    const sharedTrack = track(path.join(volumeRoot, 'Inbox', '04 - Shared Track.mp3'));

    for (const t of [houseTrack1, deepHouseTrack, chillTrack, sharedTrack]) {
      await touch(t.sourcePath);
    }

    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: node('', [], [], [
        node('House', ['House'], [houseTrack1, sharedTrack], [
          node('Deep House', ['House', 'Deep House'], [deepHouseTrack]),
        ]),
        // An empty intermediate folder: has a nested crate with tracks,
        // but no direct tracks of its own -- should get no .crate file.
        node('Genres', ['Genres'], [], [
          node('Café Chill', ['Genres', 'Café Chill'], [chillTrack]),
        ]),
        node('Favorites', ['Favorites'], [sharedTrack]),
      ]),
    };

    const result = await writeCrateDatabase(tree, subcratesDir, { volumeRoot });

    expect(result.skippedRootTracks).toEqual([]);
    expect(result.filesWritten.map((f) => path.basename(f)).sort()).toEqual(
      [
        'House.crate',
        'House%%Deep House.crate',
        'Genres%%Café Chill.crate',
        'Favorites.crate',
      ].sort()
    );
    // The empty "Genres" folder itself never gets a file.
    await expect(fs.access(path.join(subcratesDir, 'Genres.crate'))).rejects.toThrow();

    const readBack = await readCrateDatabase(subcratesDir, { volumeRoot });

    expect(readBack.unresolvedCount).toBe(0); // every track resolved to a real file
    expect(shape(readBack.root)).toEqual(shape(tree.root));
  });

  it('rejects a folder name containing "%%", which would silently corrupt the hierarchy on read-back', async () => {
    const t = track(path.join(volumeRoot, 'Inbox', 'track.mp3'));
    await touch(t.sourcePath);

    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: node('', [], [], [node('R%%B', ['R%%B'], [t])]),
    };

    await expect(writeCrateDatabase(tree, subcratesDir, { volumeRoot })).rejects.toThrow(/%%/);
  });

  it('returns root-level tracks as skipped instead of silently dropping or misfiling them', async () => {
    const rootTrack = track(path.join(volumeRoot, 'Inbox', 'loose-track.mp3'));
    await touch(rootTrack.sourcePath);

    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: node('', [], [rootTrack]),
    };

    const result = await writeCrateDatabase(tree, subcratesDir, { volumeRoot });

    expect(result.filesWritten).toEqual([]);
    expect(result.skippedRootTracks).toEqual([rootTrack]);
  });

  it('rejects a track whose source path is not under the given volume root', async () => {
    const outsideTrack = track(path.join(os.tmpdir(), 'somewhere-else', 'track.mp3'));

    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: node('', [], [], [node('Misc', ['Misc'], [outsideTrack])]),
    };

    await expect(writeCrateDatabase(tree, subcratesDir, { volumeRoot })).rejects.toThrow(/volume root/);
  });

  it('rejects a folder name containing a path separator, which would change where the file lands', async () => {
    const t = track(path.join(volumeRoot, 'Inbox', 'track.mp3'));
    await touch(t.sourcePath);

    const forwardSlash: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: node('', [], [], [node('Evil/Escape', ['Evil/Escape'], [t])]),
    };
    await expect(writeCrateDatabase(forwardSlash, subcratesDir, { volumeRoot })).rejects.toThrow(
      /path separator/
    );

    const backslash: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: node('', [], [], [node('Evil\\Escape', ['Evil\\Escape'], [t])]),
    };
    await expect(writeCrateDatabase(backslash, subcratesDir, { volumeRoot })).rejects.toThrow(
      /path separator/
    );
  });

  it('rejects a folder name that is a path-traversal segment ("." or "..")', async () => {
    const t = track(path.join(volumeRoot, 'Inbox', 'track.mp3'));
    await touch(t.sourcePath);

    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: node('', [], [], [
        node('..', ['..'], [], [node('Evil', ['..', 'Evil'], [t])]),
      ]),
    };

    await expect(writeCrateDatabase(tree, subcratesDir, { volumeRoot })).rejects.toThrow(
      /path-traversal segment/
    );
  });

  it('rejects two sibling folders that collide on the same crate filename, instead of silently overwriting', async () => {
    // Two DIFFERENT nodes that both happen to produce "Foo.crate" -- the
    // only realistic way this occurs is a malformed tree with duplicate
    // sibling names (readFolderTree/readCrateDatabase both prevent this
    // structurally, but writeCrateDatabase trusts whatever tree it's
    // given, so this is a defense-in-depth check on itself).
    const t1 = track(path.join(volumeRoot, 'Inbox', 'track1.mp3'));
    const t2 = track(path.join(volumeRoot, 'Inbox', 'track2.mp3'));
    await touch(t1.sourcePath);
    await touch(t2.sourcePath);

    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: node('', [], [], [
        node('Foo', ['Foo'], [t1]),
        node('Foo', ['Foo'], [t2]), // duplicate sibling name -> same filename
      ]),
    };

    await expect(writeCrateDatabase(tree, subcratesDir, { volumeRoot })).rejects.toThrow(
      /both map to the crate file/
    );
  });
});
