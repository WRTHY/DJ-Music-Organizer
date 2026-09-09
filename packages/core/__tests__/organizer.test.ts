import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFolderTree } from '../src/serato/folderTreeReader';
import { planFromCanonicalTree } from '../src/organizer/planner';
import { executePlan } from '../src/organizer/executor';

async function makeTmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('organizer: plan + execute', () => {
  let sourceRoot: string;
  let targetRoot: string;

  beforeEach(async () => {
    sourceRoot = await makeTmpDir('mlo-source-');
    targetRoot = await makeTmpDir('mlo-target-');
    await fs.mkdir(path.join(sourceRoot, 'House', 'Deep House'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'House', 'track1.mp3'), 'content-1');
    await fs.writeFile(path.join(sourceRoot, 'House', 'Deep House', 'track2.mp3'), 'content-2');
  });

  afterEach(async () => {
    await fs.rm(sourceRoot, { recursive: true, force: true });
    await fs.rm(targetRoot, { recursive: true, force: true });
  });

  it('copies files into a mirrored structure under the target root', async () => {
    const tree = await readFolderTree(sourceRoot);
    const plan = planFromCanonicalTree(tree, targetRoot, 'copy');
    const report = await executePlan(plan);

    expect(report.summary.copied).toBe(2);
    expect(report.summary.error).toBe(0);

    const copied1 = await fs.readFile(path.join(targetRoot, 'House', 'track1.mp3'), 'utf8');
    expect(copied1).toBe('content-1');

    const copied2 = await fs.readFile(
      path.join(targetRoot, 'House', 'Deep House', 'track2.mp3'),
      'utf8'
    );
    expect(copied2).toBe('content-2');

    // Originals are untouched.
    const original1 = await fs.readFile(path.join(sourceRoot, 'House', 'track1.mp3'), 'utf8');
    expect(original1).toBe('content-1');
  });

  it('dry run reports the plan without writing anything', async () => {
    const tree = await readFolderTree(sourceRoot);
    const plan = planFromCanonicalTree(tree, targetRoot, 'copy');
    const report = await executePlan(plan, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.summary.copied).toBe(2);

    const targetContents = await fs.readdir(targetRoot).catch(() => []);
    expect(targetContents).toHaveLength(0);
  });

  it('skips a file that already exists at the target with identical content', async () => {
    const tree = await readFolderTree(sourceRoot);
    const plan = planFromCanonicalTree(tree, targetRoot, 'copy');

    await executePlan(plan); // first run copies everything
    const secondReport = await executePlan(plan); // second run should be a no-op

    expect(secondReport.summary['skipped-duplicate']).toBe(2);
    expect(secondReport.summary.copied).toBe(0);
  });

  it('renames instead of clobbering when the target exists with different content', async () => {
    await fs.mkdir(path.join(targetRoot, 'House'), { recursive: true });
    await fs.writeFile(path.join(targetRoot, 'House', 'track1.mp3'), 'different-content');

    const tree = await readFolderTree(sourceRoot);
    const plan = planFromCanonicalTree(tree, targetRoot, 'copy');
    const report = await executePlan(plan);

    expect(report.summary.renamed).toBe(1);
    expect(report.summary.copied).toBe(1); // track2.mp3 had no conflict

    const renamed = await fs.readFile(path.join(targetRoot, 'House', 'track1 (2).mp3'), 'utf8');
    expect(renamed).toBe('content-1');

    const untouchedExisting = await fs.readFile(path.join(targetRoot, 'House', 'track1.mp3'), 'utf8');
    expect(untouchedExisting).toBe('different-content');
  });

  it('overwrites in place instead of renaming when options.allowOverwrite is set (Phase 3 diff-driven updates)', async () => {
    await fs.mkdir(path.join(targetRoot, 'House'), { recursive: true });
    await fs.writeFile(path.join(targetRoot, 'House', 'track1.mp3'), 'stale-content');

    const tree = await readFolderTree(sourceRoot);
    const plan = planFromCanonicalTree(tree, targetRoot, 'copy');
    const report = await executePlan(plan, { allowOverwrite: true });

    expect(report.summary.overwritten).toBe(1);
    expect(report.summary.renamed).toBe(0);
    expect(report.summary.copied).toBe(1); // track2.mp3 had no conflict

    // No "(2)" duplicate should exist -- the original path was updated in place.
    await expect(fs.access(path.join(targetRoot, 'House', 'track1 (2).mp3'))).rejects.toThrow();
    const updated = await fs.readFile(path.join(targetRoot, 'House', 'track1.mp3'), 'utf8');
    expect(updated).toBe('content-1');
  });

  it('allowOverwrite still skips a target whose content already matches -- it only affects genuine mismatches', async () => {
    const tree = await readFolderTree(sourceRoot);
    const plan = planFromCanonicalTree(tree, targetRoot, 'copy');

    await executePlan(plan); // first run copies everything
    const secondReport = await executePlan(plan, { allowOverwrite: true });

    expect(secondReport.summary['skipped-duplicate']).toBe(2);
    expect(secondReport.summary.overwritten).toBe(0);
  });

  it('move mode removes the original file after transfer', async () => {
    const tree = await readFolderTree(sourceRoot);
    const plan = planFromCanonicalTree(tree, targetRoot, 'move');
    const report = await executePlan(plan);

    expect(report.summary.moved).toBe(2);

    await expect(fs.access(path.join(sourceRoot, 'House', 'track1.mp3'))).rejects.toThrow();
    const moved = await fs.readFile(path.join(targetRoot, 'House', 'track1.mp3'), 'utf8');
    expect(moved).toBe('content-1');
  });
});
