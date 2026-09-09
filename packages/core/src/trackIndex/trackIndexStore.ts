import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * What's cached about one track's content, keyed by its absolute source
 * path. `size`/`mtimeMs` are the cheap signal used to decide whether a
 * cached hash can still be trusted -- if either has changed since
 * `hashedAt`, the file has to be re-hashed rather than trusted blindly.
 * This is the same stat-before-read trick git and rsync use.
 */
export interface TrackIndexEntry {
  size: number;
  mtimeMs: number;
  contentHash: string;
  hashedAt: string;
}

/**
 * Where computed content hashes are remembered across runs, so
 * re-scanning a multi-year library doesn't mean re-hashing every file's
 * bytes every time. `core` code should only ever depend on this
 * interface, never on a concrete storage format -- see the "Phase 3
 * design" entry (2026-09-09) in docs/decisions.md for why.
 */
export interface TrackIndexStore {
  get(absolutePath: string): TrackIndexEntry | undefined;
  set(absolutePath: string, entry: TrackIndexEntry): void;
  /** A snapshot of every entry currently held, keyed by absolute path. */
  all(): ReadonlyMap<string, TrackIndexEntry>;
  /** Reads the backing store into memory. Safe to call on a store that doesn't exist on disk yet -- starts empty. */
  load(): Promise<void>;
  /** Persists whatever's currently in memory. Callers decide when -- e.g. once after a whole diff run, not once per track. */
  save(): Promise<void>;
}

/**
 * A `TrackIndexStore` backed by a single JSON file. Chosen over a real
 * database (e.g. SQLite) for now: at personal-library scale (tens of
 * thousands of tracks, not millions) a JSON file is fast enough that a
 * relational store would be solving a problem this project doesn't have
 * yet, and a native module like `better-sqlite3` would add a new class of
 * Electron packaging risk this project doesn't currently carry. This
 * class is the only thing that would need to change if that ever stops
 * being true -- see docs/decisions.md, decision 17.
 */
export class JsonTrackIndexStore implements TrackIndexStore {
  private readonly filePath: string;
  private entries = new Map<string, TrackIndexEntry>();

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  get(absolutePath: string): TrackIndexEntry | undefined {
    return this.entries.get(absolutePath);
  }

  set(absolutePath: string, entry: TrackIndexEntry): void {
    this.entries.set(absolutePath, entry);
  }

  all(): ReadonlyMap<string, TrackIndexEntry> {
    return this.entries;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries = new Map();
        return;
      }
      throw err;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, TrackIndexEntry>;
      this.entries = new Map(Object.entries(parsed));
    } catch {
      // A corrupted index file is only a lost cache, never lost data --
      // every entry is recomputable from the real files on disk. Start
      // fresh rather than failing a whole scan over a cache file.
      this.entries = new Map();
    }
  }

  async save(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    const plain = Object.fromEntries(this.entries);
    const json = JSON.stringify(plain, null, 2);

    // Write to a temp file and rename over the real one so a crash
    // mid-save can never leave a half-written, corrupt index behind --
    // rename is atomic on the same filesystem.
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tempPath, json, 'utf8');
    await fs.rename(tempPath, this.filePath);
  }
}

/**
 * Returns the content hash for whatever file lives at `absolutePath`,
 * reusing a cached value from `store` when the file's size and mtime
 * still match what was recorded, and recomputing (then updating the
 * cache) otherwise. Does not persist the store -- call `store.save()`
 * once after hashing however many files a caller needs, rather than once
 * per file.
 *
 * Takes a plain path rather than a `TrackRef` deliberately: the diffing
 * step (Phase 3) needs to hash files on the *destination* side of a
 * copy/burn too, and those don't have a `TrackRef` -- they're just files
 * `readFolderTree` found sitting on disk.
 */
export async function hashWithCache(store: TrackIndexStore, absolutePath: string): Promise<string> {
  const stat = await fs.stat(absolutePath);
  const cached = store.get(absolutePath);

  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.contentHash;
  }

  const contentHash = await hashFileContents(absolutePath);
  store.set(absolutePath, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    contentHash,
    hashedAt: new Date().toISOString(),
  });
  return contentHash;
}

async function hashFileContents(absolutePath: string): Promise<string> {
  const buffer = await fs.readFile(absolutePath);
  return createHash('sha1').update(buffer).digest('hex');
}
