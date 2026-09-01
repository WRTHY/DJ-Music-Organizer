import fs from 'node:fs/promises';
import path from 'node:path';
import { SeratoSourceType } from '../types';

export interface DetectionResult {
  sourceType: SeratoSourceType;
  hasSubcratesDir: boolean;
  subcratesDir: string | null;
  hasRealSubfolders: boolean;
}

/**
 * Best-guess at how a given Serato-managed folder is organized:
 * - real subfolders under it (readFolderTree applies), and/or
 * - a `_Serato_/Subcrates` directory of .crate files (readCrateDatabase
 *   applies).
 *
 * A library can legitimately have both at once (some crates are just
 * database entries, others mirror real folders) — that's reported as
 * 'mixed' rather than guessed at further. This is a starting heuristic,
 * meant to be checked against the real library, not a final answer.
 */
export async function detectSourceType(rootPath: string): Promise<DetectionResult> {
  const subcratesDir = path.join(rootPath, '_Serato_', 'Subcrates');
  const hasSubcratesDir = await isDirectory(subcratesDir);

  const hasRealSubfolders = await hasNonHiddenSubfolder(rootPath);

  let sourceType: SeratoSourceType;
  if (hasSubcratesDir && hasRealSubfolders) sourceType = 'mixed';
  else if (hasSubcratesDir) sourceType = 'serato-crates';
  else sourceType = 'serato-folders';

  return {
    sourceType,
    hasSubcratesDir,
    subcratesDir: hasSubcratesDir ? subcratesDir : null,
    hasRealSubfolders,
  };
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function hasNonHiddenSubfolder(dirPath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.some((e) => e.isDirectory() && !e.name.startsWith('.'));
  } catch {
    return false;
  }
}
