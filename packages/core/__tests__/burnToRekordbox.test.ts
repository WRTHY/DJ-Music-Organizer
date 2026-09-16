import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CanonicalNode, CanonicalTree, TrackRef, allTracks, emptyNode } from '../src/types';
import { idForPath } from '../src/serato/hash';
import { JsonTrackIndexStore } from '../src/trackIndex/trackIndexStore';
import {
  buildExistingMembership,
  buildExistingPlaylistIndex,
  burnToRekordbox,
  classifyTracksAgainstTemplate,
  planRekordboxWriteOps,
} from '../src/rekordbox/burnToRekordbox';
import { RekordboxPlaylistEntry, RekordboxPlaylistNode, readPdbPlaylistEntries, readPdbPlaylistTree, readPdbTracks } from '../src/rekordbox/pdbReader';
import { buildCanonicalTreeFromPlaylists } from '../src/rekordbox/canonicalTree';

/**
 * Phase 5 Deliverable 3 (docs/roadmap.md): `burnToRekordbox` is the
 * Rekordbox counterpart to `burnToFlash`, but its core risk is the
 * opposite one. `burnToFlash` fully regenerates Serato's crate database
 * every time, so its scariest bug was an *unchanged* track silently
 * vanishing (see burnToFlash.test.ts). Template-modify never regenerates
 * anything -- it only ever adds -- so this suite's scariest bug is the
 * mirror image: burning the SAME library to the SAME drive twice must
 * add nothing the second time (no duplicate tracks, no duplicate
 * playlists, no duplicate playlist entries), and it must never touch
 * whatever real content was already on the template drive before this
 * project ever saw it.
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

function treeOf(root: CanonicalNode): CanonicalTree {
  return { root, generatedAt: new Date().toISOString(), sourceType: 'serato-folders' };
}

describe('classifyTracksAgainstTemplate (pure)', () => {
  it('matches a source track to an existing template track by content hash, never by path or id', () => {
    const source = new Map([
      ['src-a', 'hash-1'],
      ['src-b', 'hash-2'],
    ]);
    const existing = new Map([
      [101, 'hash-1'], // same content as src-a, totally different path/id
      [102, 'hash-9'],
    ]);
    const result = classifyTracksAgainstTemplate(source, existing);
    expect(result.get('src-a')).toEqual({ status: 'existing', existingTrackId: 101 });
    expect(result.get('src-b')).toEqual({ status: 'new' });
  });

  it('is deterministic when more than one existing track shares a hash (a real duplicate on the template)', () => {
    const source = new Map([['src-a', 'hash-1']]);
    const existing = new Map([
      [201, 'hash-1'],
      [202, 'hash-1'],
    ]);
    const result = classifyTracksAgainstTemplate(source, existing);
    expect(result.get('src-a')?.status).toBe('existing');
    expect(result.get('src-a')?.existingTrackId).toBe(201); // first one wins, consistently
  });
});

function playlistNode(id: number, parentId: number, name: string, isFolder: boolean, sortOrder = 0): RekordboxPlaylistNode {
  return { id, parentId, name, isFolder, sortOrder };
}

describe('buildExistingPlaylistIndex / buildExistingMembership (pure)', () => {
  it('indexes plain playlists and folders by path, keeping their real numeric ids', () => {
    const tree = [
      playlistNode(1, 0, 'House', true),
      playlistNode(2, 1, 'Deep', false),
    ];
    const index = buildExistingPlaylistIndex(tree);
    expect(index.get('House')).toEqual({ isFolder: true, playlistId: 1 });
    expect(index.get('House/Deep')).toEqual({ isFolder: false, playlistId: 2 });
  });

  it('surfaces a folder\'s _FolderTracks child as folderTracksPlaylistId, and does not index it as its own path', () => {
    const tree = [
      playlistNode(1, 0, 'House', true),
      playlistNode(2, 1, '_FolderTracks', false),
      playlistNode(3, 1, 'Deep', false),
    ];
    const index = buildExistingPlaylistIndex(tree);
    expect(index.get('House')).toEqual({ isFolder: true, playlistId: 1, folderTracksPlaylistId: 2 });
    expect(index.has('House/_FolderTracks')).toBe(false);
    expect(index.get('House/Deep')).toEqual({ isFolder: false, playlistId: 3 });
  });

  it('groups playlist_entries by playlistId', () => {
    const entries: RekordboxPlaylistEntry[] = [
      { playlistId: 1, trackId: 10, entryIndex: 1 },
      { playlistId: 1, trackId: 11, entryIndex: 2 },
      { playlistId: 2, trackId: 10, entryIndex: 1 },
    ];
    const membership = buildExistingMembership(entries);
    expect(membership.get(1)).toEqual(new Set([10, 11]));
    expect(membership.get(2)).toEqual(new Set([10]));
  });
});

describe('planRekordboxWriteOps (pure)', () => {
  const volumeRoot = '/Volumes/MLO-TEST';

  it('creates a new nested playlist chain and adds a new track, with no pre-existing structure to reuse', () => {
    const t = track('/library/house1.mp3');
    const tree = treeOf(node('', [], [], [node('New Music', ['New Music'], [], [node('Fresh', ['New Music', 'Fresh'], [t])])]));
    const classification = classifyTracksAgainstTemplate(new Map([[t.id, 'hash-1']]), new Map());
    const targetPaths = new Map([[t.id, path.join(volumeRoot, 'Contents', 'New Music', 'Fresh', 'house1.mp3')]]);

    const { ops, newTrackLocalIds } = planRekordboxWriteOps(tree, classification, targetPaths, volumeRoot, new Map(), new Map());

    expect(newTrackLocalIds.has(t.id)).toBe(true);
    const addTrackOps = ops.filter((op) => op.op === 'addTrack');
    expect(addTrackOps).toHaveLength(1);
    expect(addTrackOps[0]).toMatchObject({ filePath: '/Contents/New Music/Fresh/house1.mp3', title: 'house1' });

    const createOps = ops.filter((op) => op.op === 'createPlaylist');
    expect(createOps.map((op) => (op as { name: string }).name)).toEqual(['New Music', 'Fresh']);
    const freshOp = createOps.find((op) => (op as { name: string }).name === 'Fresh') as { localId: string; parentRef?: string };
    const newMusicOp = createOps.find((op) => (op as { name: string }).name === 'New Music') as { localId: string };
    expect(freshOp.parentRef).toBe(newMusicOp.localId);

    const addToPlaylistOps = ops.filter((op) => op.op === 'addToPlaylist');
    expect(addToPlaylistOps).toEqual([{ op: 'addToPlaylist', playlistRef: freshOp.localId, trackRef: newTrackLocalIds.get(t.id) }]);
  });

  it('reuses an existing playlist by id instead of recreating it, and skips a track already linked there', () => {
    const existingTrack = track('/library/already-there.mp3');
    const tree = treeOf(node('', [], [], [node('House', ['House'], [existingTrack])]));
    const classification = classifyTracksAgainstTemplate(new Map([[existingTrack.id, 'hash-1']]), new Map([[55, 'hash-1']]));
    const existingPlaylists = buildExistingPlaylistIndex([playlistNode(1, 0, 'House', false)]);
    const existingMembership = buildExistingMembership([{ playlistId: 1, trackId: 55, entryIndex: 1 }]);

    const { ops } = planRekordboxWriteOps(tree, classification, new Map(), volumeRoot, existingPlaylists, existingMembership);

    expect(ops.filter((op) => op.op === 'createPlaylist')).toHaveLength(0);
    expect(ops.filter((op) => op.op === 'addTrack')).toHaveLength(0);
    expect(ops.filter((op) => op.op === 'addToPlaylist')).toHaveLength(0); // already linked -- nothing to do
  });

  it('reuses an existing playlist but still links a track that is new to THIS playlist (already exists elsewhere on the template)', () => {
    const existingTrack = track('/library/elsewhere.mp3');
    const tree = treeOf(node('', [], [], [node('House', ['House'], [existingTrack])]));
    const classification = classifyTracksAgainstTemplate(new Map([[existingTrack.id, 'hash-1']]), new Map([[55, 'hash-1']]));
    const existingPlaylists = buildExistingPlaylistIndex([playlistNode(1, 0, 'House', false)]);
    // track 55 exists on the template, but not yet in playlist 1
    const existingMembership = buildExistingMembership([]);

    const { ops } = planRekordboxWriteOps(tree, classification, new Map(), volumeRoot, existingPlaylists, existingMembership);
    expect(ops).toEqual([{ op: 'addToPlaylist', playlistRef: '1', trackRef: '55' }]);
  });

  it('applies the _FolderTracks convention when a node needs to be both a folder and hold direct tracks', () => {
    const ownTrack = track('/library/mixed-own.mp3');
    const childTrack = track('/library/mixed-child.mp3');
    const tree = treeOf(
      node('', [], [], [node('Mixed', ['Mixed'], [ownTrack], [node('Sub', ['Mixed', 'Sub'], [childTrack])])])
    );
    const classification = classifyTracksAgainstTemplate(
      new Map([
        [ownTrack.id, 'hash-own'],
        [childTrack.id, 'hash-child'],
      ]),
      new Map()
    );
    const targetPaths = new Map([
      [ownTrack.id, '/vol/Contents/Mixed/mixed-own.mp3'],
      [childTrack.id, '/vol/Contents/Mixed/Sub/mixed-child.mp3'],
    ]);

    const { ops } = planRekordboxWriteOps(tree, classification, targetPaths, '/vol', new Map(), new Map());

    const createOps = ops.filter((op) => op.op === 'createPlaylist') as Array<{ localId: string; name: string; isFolder?: boolean; parentRef?: string }>;
    const mixedOp = createOps.find((op) => op.name === 'Mixed')!;
    const folderTracksOp = createOps.find((op) => op.name === '_FolderTracks')!;
    const subOp = createOps.find((op) => op.name === 'Sub')!;
    expect(mixedOp.isFolder).toBe(true);
    expect(folderTracksOp.parentRef).toBe(mixedOp.localId);
    expect(subOp.parentRef).toBe(mixedOp.localId);

    const addToPlaylistOps = ops.filter((op) => op.op === 'addToPlaylist') as Array<{ playlistRef: string }>;
    expect(addToPlaylistOps).toHaveLength(2);
    expect(addToPlaylistOps.some((op) => op.playlistRef === folderTracksOp.localId)).toBe(true);
    expect(addToPlaylistOps.some((op) => op.playlistRef === subOp.localId)).toBe(true);
  });

  it('creates no playlist at all for a folder with nothing anywhere in its own subtree', () => {
    const tree = treeOf(node('', [], [], [node('Empty', ['Empty'], [], [node('AlsoEmpty', ['Empty', 'AlsoEmpty'])])]));
    const { ops } = planRekordboxWriteOps(tree, new Map(), new Map(), '/vol', new Map(), new Map());
    expect(ops).toHaveLength(0);
  });

  it('omits a new track (and any addToPlaylist referencing it) whose copy never produced a target path', () => {
    const t = track('/library/failed-copy.mp3');
    const tree = treeOf(node('', [], [], [node('House', ['House'], [t])]));
    const classification = classifyTracksAgainstTemplate(new Map([[t.id, 'hash-1']]), new Map());
    // No entry in targetPaths for t.id -- simulates a copy that errored.
    const { ops, newTrackLocalIds } = planRekordboxWriteOps(tree, classification, new Map(), '/vol', new Map(), new Map());
    expect(newTrackLocalIds.has(t.id)).toBe(false);
    expect(ops.filter((op) => op.op === 'addTrack')).toHaveLength(0);
    expect(ops.filter((op) => op.op === 'addToPlaylist')).toHaveLength(0);
    // The playlist itself still isn't created either -- its only content was the skipped track.
    expect(ops.filter((op) => op.op === 'createPlaylist')).toHaveLength(0);
  });
});

// --- Integration: a real burn against the vendored library's own fixture ---
// Same split as pdbWriter.test.ts and its own doc comment: these need a
// real python3 to run the real PdbEditor, so they skip gracefully rather
// than hard-failing when it isn't present on the machine running the
// suite.

function pythonAvailable(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAVE_PYTHON = pythonAvailable();
const maybeIt = HAVE_PYTHON ? it : it.skip;

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const VENDOR_SRC_PATH = path.join(REPO_ROOT, 'vendor', 'rekordbox-pdb', 'src');
const FIXTURE_PDB = path.join(REPO_ROOT, 'vendor', 'rekordbox-pdb', 'tests', 'data', 'one-song-export.pdb');
const REAL_DRIVER_SCRIPT = path.join(__dirname, '..', 'pyscripts', 'rekordbox_write_driver.py');

describe('burnToRekordbox (integration, real PdbEditor against the vendored fixture)', () => {
  if (!HAVE_PYTHON) {
    // eslint-disable-next-line no-console
    console.warn('burnToRekordbox integration tests skipped: python3 not found on this machine.');
  }

  let volumeRoot: string;
  let sourceDir: string;
  let indexPath: string;
  let store: JsonTrackIndexStore;

  beforeEach(async () => {
    volumeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-rbburn-volume-'));
    sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-rbburn-source-'));
    indexPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-rbburn-index-')), 'index.json');
    store = new JsonTrackIndexStore(indexPath);
    await store.load();
  });

  afterEach(async () => {
    await fs.rm(volumeRoot, { recursive: true, force: true });
    await fs.rm(sourceDir, { recursive: true, force: true });
  });

  maybeIt('adds a new track under a new nested playlist, copies its audio, and verifies clean on read-back', async () => {
    const sourceFile = path.join(sourceDir, 'new-track.mp3');
    await fs.writeFile(sourceFile, 'brand new audio content');
    const tree = treeOf(
      node('', [], [], [node('MLO', ['MLO'], [], [node('Deliverable 3', ['MLO', 'Deliverable 3'], [track(sourceFile)])])])
    );
    const outputPath = path.join(volumeRoot, 'export.written.pdb');

    const report = await burnToRekordbox(tree, {
      store,
      templatePath: FIXTURE_PDB,
      outputPath,
      volumeRoot,
      writerOptions: { vendorSrcPath: VENDOR_SRC_PATH, driverScriptPath: REAL_DRIVER_SCRIPT },
    });

    expect(report.writeResult.ok).toBe(true);
    expect(report.writeResult.error).toBeUndefined();
    expect(report.diffSummary).toEqual({ new: 1, existing: 0 });
    expect(report.skippedTrackCount).toBe(0);
    expect(report.organizeReport.summary.copied).toBe(1);
    expect(report.verification.ok).toBe(true);
    expect(report.verification.missing).toEqual([]);

    // The template itself must never be touched.
    const templateStatBefore = await fs.stat(FIXTURE_PDB);
    expect(templateStatBefore.isFile()).toBe(true);

    const [tracks, playlistTree, playlistEntries] = await Promise.all([
      readPdbTracks(outputPath),
      readPdbPlaylistTree(outputPath),
      readPdbPlaylistEntries(outputPath),
    ]);
    expect(tracks).toHaveLength(2); // the fixture's original track, plus the new one
    const actualTree = buildCanonicalTreeFromPlaylists(tracks, playlistTree, playlistEntries, { volumeRoot });
    const mlo = actualTree.root.children.find((c) => c.name === 'MLO');
    const nested = mlo?.children.find((c) => c.name === 'Deliverable 3');
    expect(nested?.tracks).toHaveLength(1);
    expect(nested?.tracks[0]?.filename).toBe('new-track.mp3');

    // And the audio file really did land on the drive, at the path the pdb now references.
    const copiedContent = await fs.readFile(nested!.tracks[0]!.sourcePath, 'utf8');
    expect(copiedContent).toBe('brand new audio content');
  });

  maybeIt('burning the same library to the same drive twice adds nothing the second time', async () => {
    const sourceFile = path.join(sourceDir, 'repeat-track.mp3');
    await fs.writeFile(sourceFile, 'repeat content');
    const tree = treeOf(node('', [], [], [node('Repeat', ['Repeat'], [track(sourceFile)])]));

    const firstOutputPath = path.join(volumeRoot, 'export.first.pdb');
    const firstReport = await burnToRekordbox(tree, {
      store,
      templatePath: FIXTURE_PDB,
      outputPath: firstOutputPath,
      volumeRoot,
      writerOptions: { vendorSrcPath: VENDOR_SRC_PATH, driverScriptPath: REAL_DRIVER_SCRIPT },
    });
    expect(firstReport.writeResult.ok).toBe(true);
    expect(firstReport.diffSummary).toEqual({ new: 1, existing: 0 });

    // Second burn: same source tree, but now templated off the FIRST burn's
    // own output -- exactly how a real second burn would work once the
    // first one's output has been trusted and promoted (Deliverable 5).
    const secondOutputPath = path.join(volumeRoot, 'export.second.pdb');
    const secondStore = new JsonTrackIndexStore(path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-rbburn-index2-')), 'index.json'));
    await secondStore.load();
    const secondReport = await burnToRekordbox(tree, {
      store: secondStore,
      templatePath: firstOutputPath,
      outputPath: secondOutputPath,
      volumeRoot,
      writerOptions: { vendorSrcPath: VENDOR_SRC_PATH, driverScriptPath: REAL_DRIVER_SCRIPT },
    });

    expect(secondReport.writeResult.ok).toBe(true);
    expect(secondReport.diffSummary).toEqual({ new: 0, existing: 1 }); // matched by content hash, not re-added
    expect(secondReport.organizeReport.summary.copied ?? 0).toBe(0); // no re-copy
    expect(secondReport.writeResult.createdIds).toEqual({}); // nothing new was created at all
    expect(secondReport.verification.ok).toBe(true);
  });
});
