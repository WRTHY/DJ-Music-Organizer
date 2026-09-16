import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Thin wrapper around the vendored `rekordbox-pdb` library's `PdbEditor`
 * (see vendor/rekordbox-pdb/, and docs/decisions.md's 2026-09-15 "Phase 5
 * task #22 resolved" entry for why this project wraps a third-party
 * Python library here instead of writing its own `export.pdb` writer).
 *
 * This module knows nothing about canonical trees, diffing, or Rekordbox's
 * `_FolderTracks` convention -- that's the still-to-build `burnToRekordbox`
 * orchestrator's job (Deliverable 3). All this does is take an
 * already-decided batch of low-level operations (add this track, create
 * this playlist, add that track to that playlist) and apply them to a
 * template `export.pdb` in one PdbEditor session, via a child Python
 * process -- the same "plain function, dependency-injected environment
 * bits" shape as everything else in this project (compare `storePath` on
 * the burn handlers, or `onProgress`): the Python executable, the vendored
 * library's location, and the driver script's location are all explicit
 * parameters with sensible defaults, not hardcoded, so a test can point
 * them at stand-ins instead of the real interpreter/library.
 */

export type RekordboxWriteOp =
  | {
      op: 'addTrack';
      /** Caller-chosen key other ops in this same batch use to refer to this track before its real id exists. */
      localId: string;
      title: string;
      /** Path as it should appear inside export.pdb, e.g. "/Contents/Artist/Album/01 Track.mp3". */
      filePath: string;
      filename?: string;
      artist?: string;
      album?: string;
      genre?: string;
      key?: string;
      label?: string;
      comment?: string;
      tempo?: number; // BPM * 100, matching PdbEditor's own convention
      duration?: number; // seconds
      year?: number;
      bitrate?: number;
      sampleRate?: number;
      sampleDepth?: number;
      fileSize?: number;
      trackNumber?: number;
      discNumber?: number;
      rating?: number;
    }
  | {
      op: 'createPlaylist';
      localId: string;
      name: string;
      /** A localId from an earlier createPlaylist op in this batch, or a real numeric playlist id (as a string) already in the template. Omit for a root-level playlist. */
      parentRef?: string;
      isFolder?: boolean;
    }
  | {
      op: 'addToPlaylist';
      /** A localId from a createPlaylist op in this batch, or a real numeric id (as a string) already in the template. */
      playlistRef: string;
      /** A localId from an addTrack op in this batch, or a real numeric id (as a string) already in the template. */
      trackRef: string;
    }
  | {
      op: 'setTrackField';
      /** A localId from an addTrack op in this batch, or a real numeric id (as a string) already in the template. */
      trackRef: string;
      field: string;
      value: number;
    };

export interface RekordboxWriteResult {
  ok: boolean;
  /** localId -> the real numeric id PdbEditor assigned, one entry per addTrack/createPlaylist op. Empty on failure. */
  createdIds: Record<string, number>;
  /** Present only when ok is false. */
  error?: string;
}

export interface RekordboxWriteOptions {
  /**
   * Command used to launch Python. No cross-platform default is safe to
   * assume: a typical python.org Windows install puts `python` (not
   * `python3`) on PATH, while most Linux distributions only ship
   * `python3` unless `python-is-python3` is installed. Deliberately left
   * for the caller (eventually `registerIpc.ts`, resolving
   * `process.platform`, the same way it resolves `storePath`) rather than
   * guessed at here -- see docs/decisions.md, Deliverable 2 entry.
   */
  pythonExecutable?: string;
  /** Absolute path to vendor/rekordbox-pdb/src. Defaults to that real location, resolved relative to this file. */
  vendorSrcPath?: string;
  /** Absolute path to rekordbox_write_driver.py. Defaults to the copy shipped alongside this module. */
  driverScriptPath?: string;
}

const DEFAULT_VENDOR_SRC_PATH = path.join(__dirname, '..', '..', '..', '..', 'vendor', 'rekordbox-pdb', 'src');
const DEFAULT_DRIVER_SCRIPT_PATH = path.join(__dirname, '..', '..', 'pyscripts', 'rekordbox_write_driver.py');

/**
 * Applies `ops` to `templatePath` in one PdbEditor session and writes the
 * result to `outputPath` -- never mutating `templatePath` itself. Spawns
 * Python once per call; there is no persistent interpreter or pooling,
 * since a burn is an infrequent, human-triggered operation, not a hot
 * path (same reasoning as `JsonTrackIndexStore` loading fresh each call).
 */
export async function writeRekordboxPdb(
  templatePath: string,
  outputPath: string,
  ops: RekordboxWriteOp[],
  options: RekordboxWriteOptions = {}
): Promise<RekordboxWriteResult> {
  const pythonExecutable = options.pythonExecutable ?? 'python3';
  const vendorSrcPath = options.vendorSrcPath ?? DEFAULT_VENDOR_SRC_PATH;
  const driverScriptPath = options.driverScriptPath ?? DEFAULT_DRIVER_SCRIPT_PATH;

  const request = JSON.stringify({
    vendorSrcPath,
    templatePath,
    outputPath,
    ops,
  });

  return new Promise<RekordboxWriteResult>((resolve) => {
    let child;
    try {
      child = spawn(pythonExecutable, [driverScriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, createdIds: {}, error: `failed to launch "${pythonExecutable}": ${(err as Error).message}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.on('error', (err) => {
      // e.g. ENOENT -- pythonExecutable isn't on PATH at all. Surfaced as
      // a plain, actionable result rather than an unhandled rejection or
      // a bare "spawn python3 ENOENT", since this is the single most
      // likely real-world failure mode (see the pythonExecutable doc
      // above) and deserves a message that says what to do about it.
      resolve({
        ok: false,
        createdIds: {},
        error: `could not run "${pythonExecutable}" (${err.message}). Is Python 3.10+ installed and on PATH?`,
      });
    });

    child.on('close', (code) => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve({
          ok: false,
          createdIds: {},
          error: `"${pythonExecutable}" produced no output (exit code ${code}).${stderr ? ` stderr: ${stderr.trim()}` : ''}`,
        });
        return;
      }
      let parsed: { ok: boolean; createdIds?: Record<string, number>; error?: string };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        resolve({
          ok: false,
          createdIds: {},
          error: `could not parse output from "${pythonExecutable}" as JSON: ${trimmed}${stderr ? ` (stderr: ${stderr.trim()})` : ''}`,
        });
        return;
      }
      resolve({
        ok: parsed.ok,
        createdIds: parsed.createdIds ?? {},
        error: parsed.error,
      });
    });

    child.stdin.write(request);
    child.stdin.end();
  });
}
