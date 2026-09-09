import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonicalNode, CanonicalTree, TrackRef, emptyNode } from '../src/types';
import { idForPath } from '../src/serato/hash';
import { diffAgainstDestination, planFromDiff, summarizeDiff } from '../src/organizer/diff';
import { executePlan } from '../src/organizer/executor';
import { JsonTrackIndexStore } from '../src/trackIndex/trackIndexStore';

/**
 * Phase 3 (docs/roadmap.md): diffing a canonical source tree against
 * whatever already exists at a destination, so re-copying (or
 * re-burning) an already-organized library only touches what's actually
 * new or changed. The end-to-end point of this feature -- "burning
 * twice in a row copies nothing the second time" -- gets its own test
 * below, composing the real diff + plan + execute pipeline rather than
 * just asserting on diff output in isolation.
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

describe('diffAgainstDestination', () => {
  let sourceDir: string;
  let targetDir: string;
  let indexPath: string;
  let store: JsonTrackIndexStore;

  beforeEach(async () => {
    sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-diff-source-'));
    targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-diff-target-'));
    indexPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-diff-index-')), 'index.json');
    store = new JsonTrackIndexStore(indexPath);
    await store.load();
  });

  afterEach(async () => {
    await fs.rm(sourceDir, { recursive: true, force: true });
    await fs.rm(targetDir, { recursive: true, force: true });
  });

  it('classifies every track as "new" when nothing exists at the destination yet', async () => {
    const trackA = path.join(sourceDir, 'a.mp3');
    await fs.writeFile(trackA, 'aaa');
    const tree = treeOf(node('', [], [track(trackA)]));

    const diff = await diffAgainstDestination(tree, targetDir, store);
    expect(diff.items).toHaveLength(1);
    expect(diff.items[0].status).toBe('new');
    expect(summarizeDiff(diff)).toEqual({ new: 1, unchanged: 0, changed: 0 });
  });

  it('classifies a track as "unchanged" when identical content already exists at its target path', async () => {
    const trackA = path.join(sourceDir, 'a.mp3');
    await fs.writeFile(trackA, 'same content');
    const tree = treeOf(node('', [], [track(trackA)]));

    // Put identical content at exactly the path the planner would compute.
    await fs.writeFile(path.join(targetDir, 'a.mp3'), 'same content');

    const diff = await diffAgainstDestination(tree, targetDir, store);
    expect(diff.items[0].status).toBe('unchanged');
    expect(summarizeDiff(diff)).toEqual({ new: 0, unchanged: 1, changed: 0 });
  });

  it('classifies a track as "changed" when different content exists at its target path', async () => {
    const trackA = path.join(sourceDir, 'a.mp3');
    await fs.writeFile(trackA, 'new version');
    const tree = treeOf(node('', [], [track(trackA)]));

    await fs.writeFile(path.join(targetDir, 'a.mp3'), 'old version');

    const diff = await diffAgainstDestination(tree, targetDir, store);
    expect(diff.items[0].status).toBe('changed');
    expect(summarizeDiff(diff)).toEqual({ new: 0, unchanged: 0, changed: 1 });
  });

  it('handles a mix of new/unchanged/changed tracks across nested folders in one diff', async () => {
    const newTrack = path.join(sourceDir, 'new.mp3');
    const unchangedTrack = path.join(sourceDir, 'unchanged.mp3');
    const changedTrack = path.join(sourceDir, 'changed.mp3');
    await fs.writeFile(newTrack, 'new');
    await fs.writeFile(unchangedTrack, 'same');
    await fs.writeFile(changedTrack, 'new content');

    const tree = treeOf(
      node('', [], [], [
        node('House', ['House'], [track(newTrack), track(unchangedTrack)]),
        node('Techno', ['Techno'], [track(changedTrack)]),
      ])
    );

    await fs.mkdir(path.join(targetDir, 'House'), { recursive: true });
    await fs.mkdir(path.join(targetDir, 'Techno'), { recursive: true });
    await fs.writeFile(path.join(targetDir, 'House', 'unchanged.mp3'), 'same');
    await fs.writeFile(path.join(targetDir, 'Techno', 'changed.mp3'), 'old content');

    const diff = await diffAgainstDestination(tree, targetDir, store);
    expect(summarizeDiff(diff)).toEqual({ new: 1, unchanged: 1, changed: 1 });
  });
});

describe('planFromDiff', () => {
  it('keeps only "new" and "changed" items, dropping "unchanged" ones', () => {
    const diff = {
      targetRoot: '/target',
      generatedAt: new Date().toISOString(),
      items: [
        { trackId: 'a', sourcePath: '/src/a.mp3', targetPath: '/target/a.mp3', status: 'new' as const },
        { trackId: 'b', sourcePath: '/src/b.mp3', targetPath: '/target/b.mp3', status: 'unchanged' as const },
        { trackId: 'c', sourcePath: '/src/c.mp3', targetPath: '/target/c.mp3', status: 'changed' as const },
      ],
    };

    const plan = planFromDiff(diff);
    expect(plan.items.map((i) => i.trackId).sort()).toEqual(['a', 'c']);
    expect(plan.targetRoot).toBe('/target');
    expect(plan.items.every((i) => i.mode === 'copy')).toBe(true);
  });
});

describe('diff + plan + execute, end to end', () => {
  let sourceDir: string;
  let targetDir: string;
  let indexPath: string;
  let store: JsonTrackIndexStore;

  beforeEach(async () => {
    sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-e2e-source-'));
    targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-e2e-target-'));
    indexPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-e2e-index-')), 'index.json');
    store = new JsonTrackIndexStore(indexPath);
    await store.load();
  });

  afterEach(async () => {
    await fs.rm(sourceDir, { recursive: true, force: true });
    await fs.rm(targetDir, { recursive: true, force: true });
  });

  it('burning/copying twice in a row copies nothing the second time', async () => {
    const trackA = path.join(sourceDir, 'a.mp3');
    const trackB = path.join(sourceDir, 'b.mp3');
    await fs.writeFile(trackA, 'content a');
    await fs.writeFile(trackB, 'content b');
    const tree = treeOf(node('', [], [track(trackA), track(trackB)]));

    // First pass: everything is new, both get copied.
    const firstDiff = await diffAgainstDestination(tree, targetDir, store);
    expect(summarizeDiff(firstDiff)).toEqual({ new: 2, unchanged: 0, changed: 0 });
    const firstPlan = planFromDiff(firstDiff);
    expect(firstPlan.items).toHaveLength(2);
    const firstReport = await executePlan(firstPlan);
    expect(firstReport.summary.copied).toBe(2);

    // Second pass against the same, now-populated destination: both
    // tracks are unchanged, so the plan is empty and nothing gets
    // touched -- this is the whole point of Phase 3's diffing.
    const secondDiff = await diffAgainstDestination(tree, targetDir, store);
    expect(summarizeDiff(secondDiff)).toEqual({ new: 0, unchanged: 2, changed: 0 });
    const secondPlan = planFromDiff(secondDiff);
    expect(secondPlan.items).toHaveLength(0);
    const secondReport = await executePlan(secondPlan);
    expect(secondReport.summary.copied).toBe(0);
  });

  it('a third pass after a source track changes only re-copies that one track', async () => {
    const trackA = path.join(sourceDir, 'a.mp3');
    const trackB = path.join(sourceDir, 'b.mp3');
    await fs.writeFile(trackA, 'content a');
    await fs.writeFile(trackB, 'content b');
    const tree = treeOf(node('', [], [track(trackA), track(trackB)]));

    await executePlan(planFromDiff(await diffAgainstDestination(tree, targetDir, store)));

    // Mutate one source track's content -- its cached hash is now stale
    // (different size), so it should be the only one flagged "changed".
    await fs.writeFile(trackA, 'content a, but different now');

    const diff = await diffAgainstDestination(tree, targetDir, store);
    expect(summarizeDiff(diff)).toEqual({ new: 0, unchanged: 1, changed: 1 });

    const plan = planFromDiff(diff);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].sourcePath).toBe(trackA);

    // Diff-driven execution passes allowOverwrite: true -- a "changed"
    // item here means "this exact track's slot has different content
    // now" (established by content hash against the specific
    // destination file the diff already checked), not an incidental
    // collision between unrelated tracks, so it should update a.mp3 in
    // place rather than rename alongside it as "a (2).mp3" (see
    // ExecuteOptions.allowOverwrite in executor.ts).
    const report = await executePlan(plan, { allowOverwrite: true });
    expect(report.summary.overwritten).toBe(1);
    expect(report.summary.renamed).toBe(0);
    const rewritten = await fs.readFile(path.join(targetDir, 'a.mp3'), 'utf8');
    expect(rewritten).toBe('content a, but different now');
  });
});
