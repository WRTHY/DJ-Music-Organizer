import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeRekordboxPdb, resolveDefaultPythonInvocation } from '../src/rekordbox/pdbWriter';
import { readPdbTracks, readPdbPlaylistTree, readPdbPlaylistEntries } from '../src/rekordbox/pdbReader';

// This module's whole job is spawning a real Python process, so its tests
// split the same way the vendored library's own tests do (see
// vendor/rekordbox-pdb/README.md): plumbing tests use a throwaway stub
// "driver" script (still real Python, but no dependency on the vendored
// library or a real .pdb file) to prove the child-process contract itself
// -- argument/stdin passing, stdout-JSON parsing, error surfacing -- and a
// separate integration test exercises the real vendored PdbEditor against
// a real (if tiny) export.pdb fixture, cross-checked with this project's
// own already-validated reader. Both need a real `python3` on the machine
// running the suite -- true in this project's scratch harness and (once
// installed, see docs/decisions.md) on James's own machine, but not
// guaranteed on an arbitrary CI runner, so the integration test skips
// gracefully rather than failing hard when python3 isn't found, the same
// posture the vendored library's own suite takes for fixtures it doesn't
// have.

function pythonAvailable(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAVE_PYTHON = pythonAvailable();
const maybeIt = HAVE_PYTHON ? it : it.skip;

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const VENDOR_SRC_PATH = path.join(REPO_ROOT, 'vendor', 'rekordbox-pdb', 'src');
const FIXTURE_PDB = path.join(REPO_ROOT, 'vendor', 'rekordbox-pdb', 'tests', 'data', 'one-song-export.pdb');
const REAL_DRIVER_SCRIPT = path.join(__dirname, '..', 'pyscripts', 'rekordbox_write_driver.py');

async function writeStubDriver(dir: string, body: string): Promise<string> {
  const scriptPath = path.join(dir, 'stub_driver.py');
  await fs.writeFile(scriptPath, body, 'utf8');
  return scriptPath;
}

describe('writeRekordboxPdb (plumbing, via a stub driver)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-pdbwriter-stub-'));
  });

  maybeIt('resolves ok:true and passes through createdIds on success', async () => {
    const script = await writeStubDriver(
      dir,
      [
        'import json, sys',
        'req = json.load(sys.stdin)',
        'print(json.dumps({"ok": True, "createdIds": {"t1": 3550, "p1": 432}}))',
      ].join('\n')
    );
    const result = await writeRekordboxPdb('/template.pdb', '/output.pdb', [], { driverScriptPath: script });
    expect(result).toEqual({ ok: true, createdIds: { t1: 3550, p1: 432 }, error: undefined });
  });

  maybeIt('passes the template path, output path, and ops through on stdin unchanged', async () => {
    const script = await writeStubDriver(
      dir,
      [
        'import json, sys',
        'req = json.load(sys.stdin)',
        'print(json.dumps({"ok": True, "createdIds": req["ops"][0]["title"] and {"echo": 1} or {}}))',
      ].join('\n')
    );
    const result = await writeRekordboxPdb(
      '/template.pdb',
      '/output.pdb',
      [{ op: 'addTrack', localId: 't1', title: 'Echo Test', filePath: '/x.mp3' }],
      { driverScriptPath: script }
    );
    expect(result.ok).toBe(true);
    expect(result.createdIds).toEqual({ echo: 1 });
  });

  maybeIt('surfaces a driver-reported failure without throwing', async () => {
    const script = await writeStubDriver(
      dir,
      ['import json', 'print(json.dumps({"ok": False, "error": "LookupError: no track with id 999"}))'].join('\n')
    );
    const result = await writeRekordboxPdb('/template.pdb', '/output.pdb', [], { driverScriptPath: script });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('LookupError: no track with id 999');
    expect(result.createdIds).toEqual({});
  });

  maybeIt('surfaces a nonzero exit with no parseable stdout as a clear error, not a throw', async () => {
    const script = await writeStubDriver(dir, ['import sys', 'sys.exit(1)'].join('\n'));
    const result = await writeRekordboxPdb('/template.pdb', '/output.pdb', [], { driverScriptPath: script });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no output/i);
  });

  maybeIt('surfaces non-JSON stdout as a clear error, not a throw', async () => {
    const script = await writeStubDriver(dir, ['print("not json")'].join('\n'));
    const result = await writeRekordboxPdb('/template.pdb', '/output.pdb', [], { driverScriptPath: script });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not parse/i);
  });

  it('surfaces a missing interpreter as a clear, actionable error rather than throwing', async () => {
    // No python3 needed for this one -- the whole point is the binary
    // does not exist, so it runs (and matters) even when HAVE_PYTHON is
    // false, which is precisely the situation a real user hits before
    // installing Python.
    const result = await writeRekordboxPdb('/template.pdb', '/output.pdb', [], {
      pythonExecutable: 'definitely-not-a-real-interpreter-93f2',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not run/i);
    expect(result.error).toMatch(/PATH/i);
  });

  maybeIt('inserts pythonArgs between the executable and the driver script, as real interpreter flags', async () => {
    // Real-world motivation, not a hypothetical: James's Windows machine
    // (docs/decisions.md, 2026-09-16) only registers Python through the
    // `py` launcher -- `py -3 script.py`, not a bare `python3 script.py`
    // -- so this option has to actually reach the spawned argv, and in
    // the right position: an interpreter flag belongs *before* the script
    // path, not after it (python3 would otherwise try to run the flag
    // itself as a script and fail). `-u` (unbuffered stdout/stderr) is a
    // real, harmless python3 flag -- if pythonArgs landed in the wrong
    // position, or as a script argument instead of an interpreter flag,
    // the driver would fail to run at all rather than merely behaving
    // differently, which is exactly what this test would catch.
    const script = await writeStubDriver(
      dir,
      ['import json', 'print(json.dumps({"ok": True, "createdIds": {"ran": 1}}))'].join('\n')
    );
    const result = await writeRekordboxPdb('/template.pdb', '/output.pdb', [], {
      driverScriptPath: script,
      pythonArgs: ['-u'],
    });
    expect(result.ok).toBe(true);
    expect(result.createdIds).toEqual({ ran: 1 });
  });
});

describe('resolveDefaultPythonInvocation', () => {
  it('resolves to the py launcher on win32, matching the confirmed real-machine finding', () => {
    expect(resolveDefaultPythonInvocation('win32')).toEqual({ executable: 'py', args: ['-3'] });
  });

  it('resolves to a bare python3 on non-Windows platforms', () => {
    expect(resolveDefaultPythonInvocation('linux')).toEqual({ executable: 'python3', args: [] });
    expect(resolveDefaultPythonInvocation('darwin')).toEqual({ executable: 'python3', args: [] });
  });

  it('defaults to the real process.platform when none is given', () => {
    expect(resolveDefaultPythonInvocation()).toEqual(resolveDefaultPythonInvocation(process.platform));
  });
});

describe('writeRekordboxPdb (integration, real PdbEditor against a real fixture)', () => {
  if (!HAVE_PYTHON) {
    // eslint-disable-next-line no-console
    console.warn('pdbWriter integration tests skipped: python3 not found on this machine.');
  }

  maybeIt(
    'appends a track, a playlist, and a playlist entry that this project\'s own reader can read back -- and leaves every existing track untouched',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-pdbwriter-integration-'));
      const outputPath = path.join(dir, 'export.written.pdb');

      const before = {
        tracks: await readPdbTracks(FIXTURE_PDB),
        playlistTree: await readPdbPlaylistTree(FIXTURE_PDB),
        playlistEntries: await readPdbPlaylistEntries(FIXTURE_PDB),
      };
      const templateBytesBefore = await fs.readFile(FIXTURE_PDB);

      const result = await writeRekordboxPdb(
        FIXTURE_PDB,
        outputPath,
        [
          {
            op: 'addTrack',
            localId: 'newTrack',
            title: 'MLO Deliverable 2 Test Track',
            filePath: '/Contents/MLO-Test/Deliverable 2 Test Track.mp3',
            artist: 'MLO Test Artist',
            tempo: 12800,
            duration: 200,
            bitrate: 320,
            sampleRate: 44100,
          },
          { op: 'createPlaylist', localId: 'newPlaylist', name: 'MLO Deliverable 2 Test Playlist' },
          { op: 'addToPlaylist', playlistRef: 'newPlaylist', trackRef: 'newTrack' },
        ],
        { vendorSrcPath: VENDOR_SRC_PATH, driverScriptPath: REAL_DRIVER_SCRIPT }
      );

      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
      expect(typeof result.createdIds.newTrack).toBe('number');
      expect(typeof result.createdIds.newPlaylist).toBe('number');

      // The template itself must be untouched -- PdbEditor.save() writes
      // to outputPath, a different file, and this is the one thing that
      // absolutely cannot regress given this project's whole posture on
      // never risking a real library.
      const templateBytesAfter = await fs.readFile(FIXTURE_PDB);
      expect(templateBytesAfter.equals(templateBytesBefore)).toBe(true);

      const after = {
        tracks: await readPdbTracks(outputPath),
        playlistTree: await readPdbPlaylistTree(outputPath),
        playlistEntries: await readPdbPlaylistEntries(outputPath),
      };

      expect(after.tracks.length).toBe(before.tracks.length + 1);
      expect(after.playlistTree.length).toBe(before.playlistTree.length + 1);
      expect(after.playlistEntries.length).toBe(before.playlistEntries.length + 1);

      const newTrack = after.tracks.find((t) => t.id === result.createdIds.newTrack);
      expect(newTrack?.title).toBe('MLO Deliverable 2 Test Track');
      expect(newTrack?.filePath).toBe('/Contents/MLO-Test/Deliverable 2 Test Track.mp3');

      const newPlaylist = after.playlistTree.find((p) => p.id === result.createdIds.newPlaylist);
      expect(newPlaylist?.name).toBe('MLO Deliverable 2 Test Playlist');

      const newEntry = after.playlistEntries.find(
        (e) => e.playlistId === result.createdIds.newPlaylist && e.trackId === result.createdIds.newTrack
      );
      expect(newEntry).toBeDefined();

      // Every pre-existing track must still be there, unchanged -- same
      // "never silently drop what was already there" bar this project
      // holds its Serato burn to (see burnToFlash.test.ts).
      const beforeById = new Map(before.tracks.map((t) => [t.id, t]));
      for (const track of after.tracks) {
        if (track.id === result.createdIds.newTrack) continue;
        expect(beforeById.get(track.id)).toEqual(track);
      }
    }
  );

  maybeIt('a batch referencing an unknown track id fails the whole batch, and writes nothing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-pdbwriter-integration-fail-'));
    const outputPath = path.join(dir, 'export.should-not-exist.pdb');

    const result = await writeRekordboxPdb(
      FIXTURE_PDB,
      outputPath,
      [{ op: 'setTrackField', trackRef: '999999', field: 'rating', value: 5 }],
      { vendorSrcPath: VENDOR_SRC_PATH, driverScriptPath: REAL_DRIVER_SCRIPT }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/999999/);

    await expect(fs.access(outputPath)).rejects.toThrow();
  });
});
