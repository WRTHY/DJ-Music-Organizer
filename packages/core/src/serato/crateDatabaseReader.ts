import fs from 'node:fs/promises';
import path from 'node:path';
import { CanonicalNode, CanonicalTree, TrackRef, emptyNode } from '../types';
import { idForPath } from './hash';

/**
 * Reader for Serato's crate-database format.
 *
 * Serato does not publish this format; what's implemented here follows
 * widely-circulated community reverse-engineering. As of 2026-09-01 it has
 * been validated against James's real library (chunk framing, `otrk`/`ptrk`
 * nesting, UTF-16BE encoding, and the `%%`-hierarchy filename convention
 * all matched a real `.crate` file byte-for-byte). See
 * docs/serato-crate-format.md for exactly what was checked and what's
 * still an open question (multi-crate membership, in particular).
 */

interface ParsedCrateFile {
  /** Path segments this crate occupies in the tree, from its filename. */
  segments: string[];
  /** Track paths as found in the file, NOT yet resolved to absolute paths. */
  rawTrackPaths: string[];
}

/** Splits a Serato subcrate filename into its hierarchy segments. */
export function segmentsFromCrateFilename(filename: string): string[] {
  const withoutExt = filename.replace(/\.crate$/i, '');
  return withoutExt.split('%%').filter((s) => s.length > 0);
}

/** Decodes a UTF-16BE buffer to a string (Node has no built-in BE decoder). */
function decodeUtf16BE(buf: Buffer): string {
  const swapped = Buffer.alloc(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    swapped[i] = buf[i + 1];
    swapped[i + 1] = buf[i];
  }
  return swapped.toString('utf16le');
}

/**
 * Parses a single .crate file's binary contents into a flat list of raw
 * track paths (assumed relative — see module doc). Chunk format assumed:
 * 4-byte ASCII tag + 4-byte big-endian length + payload, with `otrk`
 * chunks containing a nested `ptrk` chunk holding the track path.
 */
export function parseCrateBuffer(buffer: Buffer): string[] {
  const paths: string[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const tag = buffer.toString('ascii', offset, offset + 4);
    const len = buffer.readUInt32BE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + len;
    if (len < 0 || payloadEnd > buffer.length) break; // malformed / not this format

    if (tag === 'otrk') {
      paths.push(...parseTrackEntry(buffer.subarray(payloadStart, payloadEnd)));
    }

    offset = payloadEnd;
  }

  return paths;
}

function parseTrackEntry(payload: Buffer): string[] {
  const paths: string[] = [];
  let offset = 0;

  while (offset + 8 <= payload.length) {
    const tag = payload.toString('ascii', offset, offset + 4);
    const len = payload.readUInt32BE(offset + 4);
    const fieldStart = offset + 8;
    const fieldEnd = fieldStart + len;
    if (len < 0 || fieldEnd > payload.length) break;

    if (tag === 'ptrk') {
      paths.push(decodeUtf16BE(payload.subarray(fieldStart, fieldEnd)));
    }

    offset = fieldEnd;
  }

  return paths;
}

async function parseCrateFile(filePath: string): Promise<ParsedCrateFile> {
  const buffer = await fs.readFile(filePath);
  return {
    segments: segmentsFromCrateFilename(path.basename(filePath)),
    rawTrackPaths: parseCrateBuffer(buffer),
  };
}

export interface CrateDatabaseOptions {
  /**
   * The folder that raw track paths from crate files are relative to.
   * Confirmed 2026-09-01 against a real library: this is the **parent
   * directory of `_Serato_`** (e.g. if the database lives at
   * `E:\_Serato_`, pass `E:\`) — not the `_Serato_` folder itself. Track
   * paths inside crate files do not include this prefix or a drive
   * letter, e.g. `ptrk` held `New Music/_2024/Trance/Track.mp3`, meant to
   * be resolved against `E:\`.
   */
  volumeRoot: string;
}

/**
 * Reads every .crate file in a Serato `_Serato_/Subcrates` directory and
 * assembles them into a CanonicalTree, using each filename's `%%`-segments
 * for hierarchy. Tracks whose resolved path doesn't actually exist on disk
 * are kept (marked via a filename annotation) rather than silently
 * dropped, since a resolution failure most likely means `volumeRoot` was
 * passed wrong for this library, not that the track is missing.
 *
 * Note this reader treats every crate as if it exclusively "owns" the
 * tracks in it, the way a folder would. Real Serato crates don't work
 * that way — a track can belong to any number of crates at once (a genre
 * crate, an artist crate, a "Planned Sets" crate for a gig, all at the
 * same time). Building a tree this way is fine for inspecting one crate,
 * but turning the *whole* Subcrates directory into a single tree where
 * each track lives in exactly one folder requires deciding which crate
 * "wins" per track — that decision is deliberately left to the caller
 * (planner/API layer), not made here. See docs/decisions.md.
 */
export async function readCrateDatabase(
  subcratesDir: string,
  options: CrateDatabaseOptions
): Promise<CanonicalTree & { unresolvedCount: number }> {
  const entries = await fs.readdir(subcratesDir, { withFileTypes: true });
  const crateFiles = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.crate'));

  const root = emptyNode('', []);
  let unresolvedCount = 0;

  for (const entry of crateFiles) {
    const parsed = await parseCrateFile(path.join(subcratesDir, entry.name));
    const node = ensurePath(root, parsed.segments);

    for (const rawPath of parsed.rawTrackPaths) {
      const resolved = path.resolve(options.volumeRoot, rawPath);
      const exists = await fs
        .access(resolved)
        .then(() => true)
        .catch(() => false);
      if (!exists) unresolvedCount += 1;

      const track: TrackRef = {
        id: idForPath(resolved),
        sourcePath: resolved,
        filename: path.basename(resolved),
        ext: path.extname(resolved).toLowerCase(),
      };
      node.tracks.push(track);
    }
  }

  return {
    root,
    generatedAt: new Date().toISOString(),
    sourceType: 'serato-crates',
    unresolvedCount,
  };
}

function ensurePath(root: CanonicalNode, segments: string[]): CanonicalNode {
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    const segPath = segments.slice(0, i + 1);
    let child = current.children.find((c) => c.name === segments[i]);
    if (!child) {
      child = emptyNode(segments[i], segPath);
      current.children.push(child);
    }
    current = child;
  }
  return current;
}
