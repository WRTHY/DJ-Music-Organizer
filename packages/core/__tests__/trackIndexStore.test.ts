import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonTrackIndexStore, hashWithCache } from '../src/trackIndex/trackIndexStore';

/**
 * Phase 3 (docs/roadmap.md) design, decision 17 (docs/decisions.md):
 * a cached content hash is only ever trusted while a track's size and
 * mtime still match what was recorded, and the JSON index file itself
 * must survive being missing or corrupted without losing real data (it
 * only ever caches something recomputable, never the tracks themselves).
 */

function sha1(buffer: Buffer | string): string {
  return createHash('sha1').update(buffer).digest('hex');
}

describe('JsonTrackIndexStore', () => {
  let dir: string;
  let indexPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-track-index-'));
    indexPath = path.join(dir, 'index.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('starts empty when the backing file does not exist yet', async () => {
    const store = new JsonTrackIndexStore(indexPath);
    await store.load();
    expect(store.all().size).toBe(0);
    expect(store.get('/nowhere.mp3')).toBeUndefined();
  });

  it('round-trips entries through save() and a fresh load()', async () => {
    const store = new JsonTrackIndexStore(indexPath);
    await store.load();
    store.set('/library/a.mp3', { size: 100, mtimeMs: 1000, contentHash: 'aaa', hashedAt: '2026-01-01T00:00:00.000Z' });
    store.set('/library/b.mp3', { size: 200, mtimeMs: 2000, contentHash: 'bbb', hashedAt: '2026-01-01T00:00:00.000Z' });
    await store.save();

    const reloaded = new JsonTrackIndexStore(indexPath);
    await reloaded.load();
    expect(reloaded.get('/library/a.mp3')).toEqual({ size: 100, mtimeMs: 1000, contentHash: 'aaa', hashedAt: '2026-01-01T00:00:00.000Z' });
    expect(reloaded.get('/library/b.mp3')).toEqual({ size: 200, mtimeMs: 2000, contentHash: 'bbb', hashedAt: '2026-01-01T00:00:00.000Z' });
    expect(reloaded.all().size).toBe(2);
  });

  it('save() never leaves a stray temp file behind', async () => {
    const store = new JsonTrackIndexStore(indexPath);
    await store.load();
    store.set('/library/a.mp3', { size: 1, mtimeMs: 1, contentHash: 'x', hashedAt: '2026-01-01T00:00:00.000Z' });
    await store.save();

    const entries = await fs.readdir(dir);
    expect(entries).toEqual(['index.json']);
  });

  it('starts fresh (does not throw) when the index file is corrupted JSON', async () => {
    await fs.writeFile(indexPath, '{ this is not valid json', 'utf8');
    const store = new JsonTrackIndexStore(indexPath);
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.all().size).toBe(0);
  });

  it('creates intermediate directories on save() if needed', async () => {
    const nestedPath = path.join(dir, 'nested', 'sub', 'index.json');
    const store = new JsonTrackIndexStore(nestedPath);
    await store.load();
    store.set('/library/a.mp3', { size: 1, mtimeMs: 1, contentHash: 'x', hashedAt: '2026-01-01T00:00:00.000Z' });
    await store.save();

    const raw = await fs.readFile(nestedPath, 'utf8');
    expect(JSON.parse(raw)['/library/a.mp3'].contentHash).toBe('x');
  });
});

describe('hashWithCache', () => {
  let dir: string;
  let indexPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-track-index-hash-'));
    indexPath = path.join(dir, 'index.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('computes the real sha1 content hash for a file not seen before', async () => {
    const filePath = path.join(dir, 'song.mp3');
    await fs.writeFile(filePath, 'hello world');
    const store = new JsonTrackIndexStore(indexPath);
    await store.load();

    const hash = await hashWithCache(store, filePath);
    expect(hash).toBe(sha1('hello world'));
  });

  it('records what it computed in the store, keyed by absolute path', async () => {
    const filePath = path.join(dir, 'song.mp3');
    await fs.writeFile(filePath, 'hello world');
    const store = new JsonTrackIndexStore(indexPath);
    await store.load();

    const hash = await hashWithCache(store, filePath);
    const entry = store.get(filePath);
    expect(entry?.contentHash).toBe(hash);
    expect(entry?.size).toBe(Buffer.byteLength('hello world'));
  });

  it('trusts a cached hash when size and mtime both still match, without recomputing', async () => {
    const filePath = path.join(dir, 'song.mp3');
    await fs.writeFile(filePath, 'hello world');
    const stat = await fs.stat(filePath);

    const store = new JsonTrackIndexStore(indexPath);
    await store.load();
    // Plant a deliberately-wrong cached hash under a size/mtime that
    // still matches the real file -- if hashWithCache trusts the cache
    // (as it should), it returns this wrong value instead of the real
    // content hash, proving the cache-hit path actually skips re-reading
    // the file rather than always recomputing.
    store.set(filePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      contentHash: 'deliberately-wrong-cached-value',
      hashedAt: '2020-01-01T00:00:00.000Z',
    });

    const hash = await hashWithCache(store, filePath);
    expect(hash).toBe('deliberately-wrong-cached-value');
  });

  it('recomputes when the file has changed size since it was last cached', async () => {
    const filePath = path.join(dir, 'song.mp3');
    await fs.writeFile(filePath, 'hello world');

    const store = new JsonTrackIndexStore(indexPath);
    await store.load();
    // A stale entry for a *different* size than the file has now --
    // simulates the file having changed since it was cached, without
    // relying on mtime resolution (which can be too coarse to bump
    // reliably within a fast-running test).
    store.set(filePath, {
      size: 999999,
      mtimeMs: 1,
      contentHash: 'stale-value',
      hashedAt: '2020-01-01T00:00:00.000Z',
    });

    const hash = await hashWithCache(store, filePath);
    expect(hash).toBe(sha1('hello world'));
    expect(hash).not.toBe('stale-value');
    expect(store.get(filePath)?.contentHash).toBe(hash);
  });

  it('two different files with identical content get the same content hash', async () => {
    const fileA = path.join(dir, 'a.mp3');
    const fileB = path.join(dir, 'b.mp3');
    await fs.writeFile(fileA, 'same bytes');
    await fs.writeFile(fileB, 'same bytes');

    const store = new JsonTrackIndexStore(indexPath);
    await store.load();
    const hashA = await hashWithCache(store, fileA);
    const hashB = await hashWithCache(store, fileB);
    expect(hashA).toBe(hashB);
  });

  it('rejects when the track file does not exist on disk', async () => {
    const store = new JsonTrackIndexStore(indexPath);
    await store.load();
    await expect(hashWithCache(store, path.join(dir, 'missing.mp3'))).rejects.toThrow();
  });
});
