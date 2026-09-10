import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonicalNode, CanonicalTree, TrackRef, allTracks, emptyNode } from '../src/types';
import { idForPath } from '../src/serato/hash';
import { burnToFlash, diffTrackPlacement } from '../src/serato/burnToFlash';
import { JsonTrackIndexStore } from '../src/trackIndex/trackIndexStore';

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
