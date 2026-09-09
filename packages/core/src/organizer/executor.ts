import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OrganizePlan, OrganizePlanItem } from './planner';

export type OrganizeItemStatus = 'copied' | 'moved' | 'skipped-duplicate' | 'renamed' | 'overwritten' | 'error';

export interface OrganizeItemResult {
  trackId: string;
  sourcePath: string;
  /** Where the file actually ended up (may differ from the plan on a rename-to-avoid-collision). */
  finalTargetPath: string;
  status: OrganizeItemStatus;
  error?: string;
}

export interface OrganizeReport {
  results: OrganizeItemResult[];
  dryRun: boolean;
  completedAt: string;
  summary: Record<OrganizeItemStatus, number>;
}

export interface ExecuteOptions {
  /** If true, compute what would happen without touching the filesystem. */
  dryRun?: boolean;
  /**
   * When a target already exists with *different* content, the default
   * (false) never overwrites it -- it renames the new file alongside the
   * existing one ("Track (2).mp3"), since an ordinary ad hoc copy has no
   * way to know whether that collision is meaningful or just two
   * unrelated tracks landing on the same name.
   *
   * A diff-driven plan (see organizer/diff.ts, Phase 3 of
   * docs/roadmap.md) is different: a "changed" diff item already means
   * "this exact track's designated slot has different content now,"
   * established by content hash against that specific destination file,
   * not an incidental collision. Passing `true` here tells the executor
   * to trust that and overwrite in place instead of creating a
   * duplicate -- otherwise every real edit to a track would pile up an
   * ever-growing set of "(2)", "(3)"... copies at the destination every
   * time it's re-burned or re-copied, which defeats the point of
   * diffing. Still never touches a target whose content already matches
   * the source (that stays `skipped-duplicate` either way).
   */
  allowOverwrite?: boolean;
}

/**
 * Executes an OrganizePlan: for each item, creates the destination folder,
 * then copies or moves the file. Conflict handling:
 * - if a file already exists at the target and has identical content
 *   (compared by sha1), the item is skipped as an already-organized
 *   duplicate;
 * - if a file already exists with *different* content, the target is
 *   renamed ("Track (2).mp3") rather than clobbering it -- unless
 *   `options.allowOverwrite` is set, in which case it's overwritten in
 *   place (see ExecuteOptions.allowOverwrite for why a diff-driven plan
 *   wants that instead).
 */
export async function executePlan(
  plan: OrganizePlan,
  options: ExecuteOptions = {}
): Promise<OrganizeReport> {
  const dryRun = !!options.dryRun;
  const allowOverwrite = !!options.allowOverwrite;
  const results: OrganizeItemResult[] = [];

  for (const item of plan.items) {
    results.push(await executeItem(item, dryRun, allowOverwrite));
  }

  const summary = results.reduce<Record<OrganizeItemStatus, number>>(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    { copied: 0, moved: 0, 'skipped-duplicate': 0, renamed: 0, overwritten: 0, error: 0 }
  );

  return {
    results,
    dryRun,
    completedAt: new Date().toISOString(),
    summary,
  };
}

async function executeItem(item: OrganizePlanItem, dryRun: boolean, allowOverwrite: boolean): Promise<OrganizeItemResult> {
  try {
    const targetDir = path.dirname(item.targetPath);
    if (!dryRun) await fs.mkdir(targetDir, { recursive: true });

    const collision = await resolveCollision(item.targetPath, item.sourcePath, allowOverwrite);
    if (collision.status === 'skipped-duplicate') {
      return {
        trackId: item.trackId,
        sourcePath: item.sourcePath,
        finalTargetPath: item.targetPath,
        status: 'skipped-duplicate',
      };
    }

    const finalTargetPath = collision.targetPath;
    const status: OrganizeItemStatus =
      collision.status === 'renamed'
        ? 'renamed'
        : collision.status === 'overwritten'
          ? 'overwritten'
          : item.mode === 'move'
            ? 'moved'
            : 'copied';

    if (!dryRun) {
      if (item.mode === 'copy') {
        await fs.copyFile(item.sourcePath, finalTargetPath);
      } else {
        await moveFile(item.sourcePath, finalTargetPath);
      }
    }

    return {
      trackId: item.trackId,
      sourcePath: item.sourcePath,
      finalTargetPath,
      status,
    };
  } catch (err) {
    return {
      trackId: item.trackId,
      sourcePath: item.sourcePath,
      finalTargetPath: item.targetPath,
      status: 'error',
      error: (err as Error).message,
    };
  }
}

async function moveFile(source: string, target: string): Promise<void> {
  try {
    await fs.rename(source, target);
  } catch (err) {
    // rename() fails across filesystems/volumes (e.g. flash drive -> internal
    // disk); fall back to copy + delete in that case.
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await fs.copyFile(source, target);
      await fs.unlink(source);
    } else {
      throw err;
    }
  }
}

type CollisionResolution =
  | { status: 'clear'; targetPath: string }
  | { status: 'renamed'; targetPath: string }
  | { status: 'overwritten'; targetPath: string }
  | { status: 'skipped-duplicate'; targetPath: string };

async function resolveCollision(targetPath: string, sourcePath: string, allowOverwrite: boolean): Promise<CollisionResolution> {
  const alreadyExists = await pathExists(targetPath);
  if (!alreadyExists) return { status: 'clear', targetPath };

  const [sourceHash, targetHash] = await Promise.all([hashFile(sourcePath), hashFile(targetPath)]);
  if (sourceHash === targetHash) {
    return { status: 'skipped-duplicate', targetPath };
  }

  if (allowOverwrite) {
    return { status: 'overwritten', targetPath };
  }

  const renamed = await findAvailableName(targetPath);
  return { status: 'renamed', targetPath: renamed };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(p: string): Promise<string> {
  const buffer = await fs.readFile(p);
  return createHash('sha1').update(buffer).digest('hex');
}

async function findAvailableName(targetPath: string): Promise<string> {
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);

  let attempt = 2;
  let candidate = path.join(dir, `${base} (${attempt})${ext}`);
  while (await pathExists(candidate)) {
    attempt += 1;
    candidate = path.join(dir, `${base} (${attempt})${ext}`);
  }
  return candidate;
}
