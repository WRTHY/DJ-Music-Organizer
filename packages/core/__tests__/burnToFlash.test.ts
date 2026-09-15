import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BurnProgress, CanonicalNode, CanonicalTree, TrackRef, allTracks, emptyNode } from '../src/types';
import { idForPath } from '../src/serato/hash';
import { burnToFlash, diffTrackPlacement } from '../src/serato/burnToFlash';
import { DATABASE_V2_FILENAME } from '../src/serato/databaseV2Writer';
import { readDatabaseV2 } from '../src/serato/databaseV2Reader';
import { JsonTrackIndexStore } from '../src/trackIndex/trackIndexStore';

// Independent chunk/UTF-16BE encoding, same rationale as
// databaseV2Writer.test.ts's copy: builds fixture bytes the way a real
// already-analyzed database V2 looks, rather than only round-tripping
// against this project's own writer.
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

/**
 * Phase 3 (docs/roadmap.md): the burn-to-flash orchestrator composes
 * diffing, copying, crate writing, and read-back verification into one
 * operation. The most safety-critical property this suite proves isn't
 * "it copies files" (that's organizer/diff.test.ts's job) -- it's that
 * an *unchanged* track, one whose audio file is deliberately NOT
 * re-copied on a second burn, still ends up correctly referenced in the
 * regenerated crate database. Getting that wrong would mean a track
 * silently disappears from a DJ's crates on a second burn while its
 * audio file sits untouched and fine on disk -- exactly the kind of bug
 * this whole phased, risk-ordered project exists to catch before it ever
 * touches a real library.
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

describe('burnToFlash', () => {
  let sourceDir: string;
  let volumeDir: string;
  let indexPath: string;
  let store: JsonTrackIndexStore;

  beforeEach(async () => {
    sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-burn-source-'));
    volumeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-burn-volume-'));
    indexPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-burn-index-')), 'index.json');
    store = new JsonTrackIndexStore(indexPath);
    await store.load();
  });

  afterEach(async () => {
    await fs.rm(sourceDir, { recursive: true, force: true });
    await fs.rm(volumeDir, { recursive: true, force: true });
  });

  it('first burn: copies every track and writes a crate database that verifies clean', async () => {
    const houseTrack = path.join(sourceDir, 'house1.mp3');
    const technoTrack = path.join(sourceDir, 'techno1.mp3');
    await fs.writeFile(houseTrack, 'house content');
    await fs.writeFile(technoTrack, 'techno content');

    const tree = treeOf(
      node('', [], [], [
        node('House', ['House'], [track(houseTrack)]),
        node('Techno', ['Techno'], [track(technoTrack)]),
      ])
    );

    const report = await burnToFlash(tree, volumeDir, { store });

    expect(report.diffSummary).toEqual({ new: 2, unchanged: 0, changed: 0 });
    expect(report.organizeReport.summary.copied).toBe(2);
    expect(report.crateWriteResult.filesWritten).toHaveLength(2);
    expect(report.verification.ok).toBe(true);
    expect(report.verification.unresolvedCount).toBe(0);
    expect(report.verification.missingTrackIds).toEqual([]);
    expect(report.verification.unexpectedTrackIds).toEqual([]);

    const copiedHouse = await fs.readFile(path.join(volumeDir, 'House', 'house1.mp3'), 'utf8');
    expect(copiedHouse).toBe('house content');

    // Phase 3b, Deliverable 4: a blank target gets a fresh database V2
    // alongside the crate database.
    expect(report.databaseV2).toMatchObject({ written: true, trackCount: 2 });
    const dbV2Path = path.join(volumeDir, '_Serato_', DATABASE_V2_FILENAME);
    const dbV2ReadBack = await readDatabaseV2(dbV2Path);
    expect(dbV2ReadBack.tracks.map((t) => t.rawPath).sort()).toEqual(
      ['House/house1.mp3', 'Techno/techno1.mp3'].sort()
    );
  });

  it('a second burn to a volume that already has a database V2 leaves it alone instead of overwriting or refusing the whole burn', async () => {
    const houseTrack = path.join(sourceDir, 'house1.mp3');
    await fs.writeFile(houseTrack, 'house content');
    const tree = treeOf(node('House', ['House'], [track(houseTrack)]));

    const firstReport = await burnToFlash(tree, volumeDir, { store });
    expect(firstReport.databaseV2).toMatchObject({ written: true, trackCount: 1 });

    const dbV2Path = path.join(volumeDir, '_Serato_', DATABASE_V2_FILENAME);
    const originalBytes = await fs.readFile(dbV2Path);

    // Add a track and burn again -- the crate database and copied files
    // should still update normally (that's Phase 3's already-proven
    // behavior), but database V2 is this phase's "blank drive only"
    // case, so it must be left completely untouched on a target that
    // already has one.
    const newTrack = path.join(sourceDir, 'house2.mp3');
    await fs.writeFile(newTrack, 'house content 2');
    const updatedTree = treeOf(node('House', ['House'], [track(houseTrack), track(newTrack)]));

    const secondReport = await burnToFlash(updatedTree, volumeDir, { store });

    expect(secondReport.databaseV2).toEqual({ written: false, reason: 'already-exists' });
    expect(secondReport.verification.ok).toBe(true); // the crate side still burns and verifies normally
    const bytesAfterSecondBurn = await fs.readFile(dbV2Path);
    expect(bytesAfterSecondBurn).toEqual(originalBytes); // byte-for-byte untouched, not merged or regenerated
  });

  /**
   * The 2026-09-14 fix: a burn can be pointed at an already-analyzed
   * `database V2` (e.g. James's live library) so tracks it already knows
   * about carry their full analysis-state records forward instead of
   * being re-synthesized minimally -- see
   * `DatabaseV2WriteOptions.sourceRecords`'s doc for the hardware
   * evidence this addresses (docs/decisions.md, 2026-09-14).
   */
  it('sourceDatabaseV2: carries an already-analyzed track record forward into a fresh burn', async () => {
    const houseTrack = path.join(sourceDir, 'house1.mp3');
    await fs.writeFile(houseTrack, 'house content');
    const tree = treeOf(node('House', ['House'], [track(houseTrack)]));

    // A separate "already-analyzed database V2" -- its own file, unrelated
    // to the burn destination -- with a full record for this exact source
    // track. Its pfil ("house1.mp3") is deliberately given volumeRoot:
    // sourceDir below, so it resolves to the real houseTrack path directly
    // -- exactly the shape of "the same track, already analyzed elsewhere
    // (e.g. James's live library), now being burned to a fresh drive."
    const sourceDbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-burn-analyzed-'));
    const sourceDbPath = path.join(sourceDbDir, 'database V2');
    const analyzedRecord = Buffer.concat([
      tlv('pfil', encodeUtf16BE('house1.mp3')),
      tlv('ttyp', encodeUtf16BE('mp3')),
      tlv('tsng', encodeUtf16BE('Already Analyzed')),
      tlv('bbgl', Buffer.from([1])), // beatgrid-locked flag -- not decoded by readDatabaseV2 at all
    ]);
    await fs.writeFile(
      sourceDbPath,
      Buffer.concat([tlv('vrsn', encodeUtf16BE('2.0/Serato Scratch LIVE Database')), tlv('otrk', analyzedRecord)])
    );

    const report = await burnToFlash(tree, volumeDir, {
      store,
      sourceDatabaseV2: { filePath: sourceDbPath, volumeRoot: sourceDir },
    });

    expect(report.databaseV2).toMatchObject({ written: true, trackCount: 1, preservedCount: 1 });

    const dbV2Path = path.join(volumeDir, '_Serato_', DATABASE_V2_FILENAME);
    const readBack = await readDatabaseV2(dbV2Path);
    expect(readBack.tracks).toEqual([
      {
        rawPath: 'House/house1.mp3', // repointed at the burn destination's own path, not the source library's
        fileType: 'mp3',
        title: 'Already Analyzed', // carried forward from the analyzed record
      },
    ]);

    await fs.rm(sourceDbDir, { recursive: true, force: true });
  });

  it('sourceDatabaseV2 omitted: burns exactly as before this option existed (minimal fields, preservedCount 0)', async () => {
    const houseTrack = path.join(sourceDir, 'house1.mp3');
    await fs.writeFile(houseTrack, 'house content');
    const tree = treeOf(node('House', ['House'], [track(houseTrack)]));

    const report = await burnToFlash(tree, volumeDir, { store });
    expect(report.databaseV2).toMatchObject({ written: true, trackCount: 1, preservedCount: 0 });
  });

  it('second burn with no source changes: copies nothing, but the crate database still references every track', async () => {
    const houseTrack = path.join(sourceDir, 'house1.mp3');
    const technoTrack = path.join(sourceDir, 'techno1.mp3');
    await fs.writeFile(houseTrack, 'house content');
    await fs.writeFile(technoTrack, 'techno content');

    const tree = treeOf(
      node('', [], [], [
        node('House', ['House'], [track(houseTrack)]),
        node('Techno', ['Techno'], [track(technoTrack)]),
      ])
    );

    await burnToFlash(tree, volumeDir, { store });
    const secondReport = await burnToFlash(tree, volumeDir, { store });

    expect(secondReport.diffSummary).toEqual({ new: 0, unchanged: 2, changed: 0 });
    expect(secondReport.organizeReport.summary.copied).toBe(0);
    // The critical assertion: even though nothing was re-copied, the
    // regenerated crate database must still contain both tracks -- an
    // "unchanged" track must never silently vanish from the crates.
    expect(secondReport.crateWriteResult.filesWritten).toHaveLength(2);
    expect(secondReport.verification.ok).toBe(true);
    expect(secondReport.verification.missingTrackIds).toEqual([]);
  });

  it('adding a new track between burns only copies the new one, and the crate database gains it without losing the others', async () => {
    const houseTrack = path.join(sourceDir, 'house1.mp3');
    await fs.writeFile(houseTrack, 'house content');
    const tree = treeOf(node('House', ['House'], [track(houseTrack)]));

    await burnToFlash(tree, volumeDir, { store });

    const newTrack = path.join(sourceDir, 'house2.mp3');
    await fs.writeFile(newTrack, 'house content 2');
    const updatedTree = treeOf(node('House', ['House'], [track(houseTrack), track(newTrack)]));

    const secondReport = await burnToFlash(updatedTree, volumeDir, { store });

    expect(secondReport.diffSummary).toEqual({ new: 1, unchanged: 1, changed: 0 });
    expect(secondReport.organizeReport.summary.copied).toBe(1);
    expect(secondReport.crateWriteResult.filesWritten).toHaveLength(1); // one crate ("House"), still written fresh
    expect(secondReport.verification.ok).toBe(true);

    const bothOnDisk = await fs.readdir(path.join(volumeDir, 'House'));
    expect(bothOnDisk.sort()).toEqual(['house1.mp3', 'house2.mp3']);
  });

  it('a changed source track is overwritten in place at the destination, not renamed aside', async () => {
    const houseTrack = path.join(sourceDir, 'house1.mp3');
    await fs.writeFile(houseTrack, 'original content');
    const tree = treeOf(node('House', ['House'], [track(houseTrack)]));

    await burnToFlash(tree, volumeDir, { store });
    await fs.writeFile(houseTrack, 'edited content');

    const secondReport = await burnToFlash(tree, volumeDir, { store });

    expect(secondReport.diffSummary).toEqual({ new: 0, unchanged: 0, changed: 1 });
    expect(secondReport.organizeReport.summary.overwritten).toBe(1);
    expect(secondReport.organizeReport.summary.renamed).toBe(0);
    expect(secondReport.verification.ok).toBe(true);

    const filesAtDestination = await fs.readdir(path.join(volumeDir, 'House'));
    expect(filesAtDestination).toEqual(['house1.mp3']); // no "house1 (2).mp3" duplicate
    const content = await fs.readFile(path.join(volumeDir, 'House', 'house1.mp3'), 'utf8');
    expect(content).toBe('edited content');
  });

  it('does not mutate the source tree passed in -- its tracks still point at the source library afterward', async () => {
    const houseTrack = path.join(sourceDir, 'house1.mp3');
    await fs.writeFile(houseTrack, 'house content');
    const tree = treeOf(node('House', ['House'], [track(houseTrack)]));

    await burnToFlash(tree, volumeDir, { store });

    const tracksStill = allTracks(tree);
    expect(tracksStill).toHaveLength(1);
    expect(tracksStill[0].track.sourcePath).toBe(houseTrack);
  });

  /**
   * Phase 3b burn progress (docs/decisions.md, 2026-09-14 -- "the single
   * spinner is a little ambiguous"). `onProgress` composes the itemized
   * events from `diffAgainstDestination`/`executePlan` with three
   * single-shot events `burnToFlash` fires itself around the crate
   * write, the database V2 write, and verification -- this is the one
   * test that proves the full sequence actually comes through in the
   * right order end to end, since the two lower-level pieces are only
   * ever tested individually (organizer/diff.test.ts).
   */
  it('onProgress reports every phase, in order, with the itemized phases carrying an accurate total', async () => {
    const houseTrack = path.join(sourceDir, 'house1.mp3');
    const technoTrack = path.join(sourceDir, 'techno1.mp3');
    await fs.writeFile(houseTrack, 'house content');
    await fs.writeFile(technoTrack, 'techno content');

    const tree = treeOf(
      node('', [], [], [
        node('House', ['House'], [track(houseTrack)]),
        node('Techno', ['Techno'], [track(technoTrack)]),
      ])
    );

    const events: BurnProgress[] = [];
    await burnToFlash(tree, volumeDir, { store, onProgress: (p) => events.push(p) });

    // Phase order: two 'diffing' events (one per track), then two
    // 'copying' events, then one each of the three single-shot phases --
    // never interleaved, and never missing.
    expect(events.map((e) => e.phase)).toEqual([
      'diffing',
      'diffing',
      'copying',
      'copying',
      'writingCrates',
      'writingDatabaseV2',
      'verifying',
    ]);

    const diffingEvents = events.filter((e) => e.phase === 'diffing');
    expect(diffingEvents.every((e) => e.total === 2)).toBe(true);
    expect(diffingEvents.map((e) => e.processed)).toEqual([1, 2]);

    const copyingEvents = events.filter((e) => e.phase === 'copying');
    expect(copyingEvents.every((e) => e.total === 2)).toBe(true);
    expect(copyingEvents.map((e) => e.processed)).toEqual([1, 2]);

    const singleShotEvents = events.filter((e) => e.phase !== 'diffing' && e.phase !== 'copying');
    expect(singleShotEvents.every((e) => e.processed === 0 && e.total === undefined)).toBe(true);
  });

  it('a second burn with nothing new to copy still reports a diffing event, but no copying events', async () => {
    const houseTrack = path.join(sourceDir, 'house1.mp3');
    await fs.writeFile(houseTrack, 'house content');
    const tree = treeOf(node('House', ['House'], [track(houseTrack)]));

    await burnToFlash(tree, volumeDir, { store });

    const events: BurnProgress[] = [];
    await burnToFlash(tree, volumeDir, { store, onProgress: (p) => events.push(p) });

    // diffAgainstDestination still classifies (and reports) every track in
    // the plan regardless of status -- it's executePlan's plan that's
    // empty, since planFromDiff drops 'unchanged' items before executePlan
    // ever sees them (see organizer/diff.ts). So the second burn still
    // gets one 'diffing' event for the one (now-unchanged) track, zero
    // 'copying' events, and the three single-shot phases still fire --
    // writing crates/database V2/verifying always happens regardless of
    // whether anything was actually copied.
    expect(events.map((e) => e.phase)).toEqual(['diffing', 'writingCrates', 'writingDatabaseV2', 'verifying']);
  });

  it('handles nested crate hierarchies, matching the same "%%" convention as the writer', async () => {
    const deepTrack = path.join(sourceDir, 'deep.mp3');
    await fs.writeFile(deepTrack, 'deep content');
    const tree = treeOf(
      node('', [], [], [
        node('House', ['House'], [], [node('Deep House', ['House', 'Deep House'], [track(deepTrack)])]),
      ])
    );

    const report = await burnToFlash(tree, volumeDir, { store });
    expect(report.verification.ok).toBe(true);

    const crateFiles = await fs.readdir(path.join(volumeDir, '_Serato_', 'Subcrates'));
    expect(crateFiles).toContain('House%%Deep House.crate');

    const copied = await fs.readFile(path.join(volumeDir, 'House', 'Deep House', 'deep.mp3'), 'utf8');
    expect(copied).toBe('deep content');
  });
});

/**
 * `diffTrackPlacement` directly, no burn/filesystem involved -- this is
 * the specific gap raised 2026-09-10: comparing burned output against
 * the intended tree as a flat set of "does this track id exist
 * anywhere" cannot tell a track apart from the *same* track silently
 * reassigned to the wrong crate, which is exactly the "burn looked
 * clean but a folder was wrong once I got to the club" failure mode.
 * These prove the per-crate-path comparison actually distinguishes
 * "missing," "unexpected," and "misplaced" from each other, hand-built
 * so a real burn/writer bug isn't needed to exercise the detection.
 */
describe('diffTrackPlacement', () => {
  it('reports no differences when both trees place every track the same way', () => {
    const trackA = track('/lib/a.mp3');
    const trackB = track('/lib/b.mp3');
    const expected = treeOf(node('', [], [], [node('House', ['House'], [trackA]), node('Techno', ['Techno'], [trackB])]));
    const actual = treeOf(node('', [], [], [node('House', ['House'], [trackA]), node('Techno', ['Techno'], [trackB])]));

    expect(diffTrackPlacement(expected, actual)).toEqual({
      missingTrackIds: [],
      unexpectedTrackIds: [],
      misplacedTrackIds: [],
    });
  });

  it('catches two tracks silently swapped between crates, even though every track id still exists somewhere', () => {
    const trackA = track('/lib/a.mp3');
    const trackB = track('/lib/b.mp3');
    const expected = treeOf(node('', [], [], [node('House', ['House'], [trackA]), node('Techno', ['Techno'], [trackB])]));
    // Same two tracks, same total count, nothing missing or extra library-wide -- just under the wrong crate each.
    const actual = treeOf(node('', [], [], [node('House', ['House'], [trackB]), node('Techno', ['Techno'], [trackA])]));

    const result = diffTrackPlacement(expected, actual);
    expect(result.missingTrackIds).toEqual([]);
    expect(result.unexpectedTrackIds).toEqual([]);
    expect(result.misplacedTrackIds.sort()).toEqual([trackA.id, trackB.id].sort());
  });

  it('reports a track missing everywhere as missing, not misplaced', () => {
    const trackA = track('/lib/a.mp3');
    const expected = treeOf(node('House', ['House'], [trackA]));
    const actual = treeOf(node('House', ['House'], []));

    const result = diffTrackPlacement(expected, actual);
    expect(result.missingTrackIds).toEqual([trackA.id]);
    expect(result.misplacedTrackIds).toEqual([]);
  });

  it('reports a track the tree never expected anywhere as unexpected', () => {
    const trackA = track('/lib/a.mp3');
    const expected = treeOf(node('House', ['House'], []));
    const actual = treeOf(node('House', ['House'], [trackA]));

    const result = diffTrackPlacement(expected, actual);
    expect(result.unexpectedTrackIds).toEqual([trackA.id]);
    expect(result.misplacedTrackIds).toEqual([]);
  });

  it('treats a track moved one level up (folder to its own parent) as misplaced, not missing', () => {
    const trackA = track('/lib/a.mp3');
    const expected = treeOf(node('House', ['House'], [], [node('Deep House', ['House', 'Deep House'], [trackA])]));
    const actual = treeOf(node('House', ['House'], [trackA])); // same track, one path segment shorter

    const result = diffTrackPlacement(expected, actual);
    expect(result.missingTrackIds).toEqual([]);
    expect(result.unexpectedTrackIds).toEqual([]);
    expect(result.misplacedTrackIds).toEqual([trackA.id]);
  });
});
