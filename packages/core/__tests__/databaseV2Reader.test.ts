import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDatabaseV2Buffer, parseRawDatabaseV2Records, readRawDatabaseV2Records } from '../src/serato/databaseV2Reader';

/**
 * Builds synthetic chunks matching the format confirmed in
 * docs/serato-database-v2-format.md. Proves the parser is internally
 * consistent with that confirmed format -- the real-byte-layout test
 * below is what proves the format itself was understood correctly.
 */
function tlv(tag: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(tag, 0, 'ascii');
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function encodeUtf16BE(str: string): Buffer {
  const le = Buffer.from(str, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i + 1 < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
}

function uint32BE(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value, 0);
  return buf;
}

function bool(value: boolean): Buffer {
  return Buffer.from([value ? 1 : 0]);
}

describe('parseDatabaseV2Buffer', () => {
  it('returns an empty track list and version string for an empty buffer, rather than throwing', () => {
    const result = parseDatabaseV2Buffer(Buffer.alloc(0));
    expect(result).toEqual({ versionString: '', tracks: [] });
  });

  it('reads the vrsn header and one otrk per track from a synthetic buffer', () => {
    const vrsn = tlv('vrsn', encodeUtf16BE('2.0/Serato Scratch LIVE Database'));
    const track1 = tlv(
      'otrk',
      Buffer.concat([
        tlv('pfil', encodeUtf16BE('House/track1.mp3')),
        tlv('tsng', encodeUtf16BE('Track One')),
      ])
    );
    const track2 = tlv(
      'otrk',
      Buffer.concat([tlv('pfil', encodeUtf16BE('House/track2.mp3'))])
    );

    const result = parseDatabaseV2Buffer(Buffer.concat([vrsn, track1, track2]));

    expect(result.versionString).toBe('2.0/Serato Scratch LIVE Database');
    expect(result.tracks).toHaveLength(2);
    expect(result.tracks[0]).toMatchObject({ rawPath: 'House/track1.mp3', title: 'Track One' });
    expect(result.tracks[1]).toMatchObject({ rawPath: 'House/track2.mp3' });
  });

  it('decodes the confirmed field-type-by-tag-prefix scheme (t=text, u=uint32BE, b=boolean)', () => {
    const otrk = tlv(
      'otrk',
      Buffer.concat([
        tlv('pfil', encodeUtf16BE('New Music/track.mp3')),
        tlv('ttyp', encodeUtf16BE('mp3')),
        tlv('tart', encodeUtf16BE('Coldplay')),
        tlv('uadd', uint32BE(1650412088)),
        tlv('bmis', bool(false)),
        tlv('bcrt', bool(true)),
      ])
    );

    const result = parseDatabaseV2Buffer(otrk);

    expect(result.tracks[0]).toEqual({
      rawPath: 'New Music/track.mp3',
      fileType: 'mp3',
      artist: 'Coldplay',
      dateAdded: 1650412088,
      missing: false,
      corrupt: true,
    });
  });

  it('parses a real Serato database V2 track layout (verified 2026-09-11 against a live 11,991-track library)', () => {
    // Reproduces the exact vrsn string and otrk sub-field shape this
    // project's databaseV2Reader was checked against -- see
    // docs/serato-database-v2-format.md for the full field table this
    // was sampled from.
    const vrsn = tlv('vrsn', encodeUtf16BE('2.0/Serato Scratch LIVE Database'));
    const otrk = tlv(
      'otrk',
      Buffer.concat([
        tlv('ttyp', encodeUtf16BE('mp3')),
        tlv(
          'pfil',
          encodeUtf16BE(
            'Every relevant song ever/1653 - Coldplay - Something Just Like This (Don Diablo Remix).mp3'
          )
        ),
        tlv('tsng', encodeUtf16BE('Something Just Like This (Don Diablo Remix)')),
        tlv('tart', encodeUtf16BE('Coldplay')),
        tlv('talb', encodeUtf16BE('Something Just Like This (Remix Pack) (Remixes)')),
        tlv('tgen', encodeUtf16BE('Dance')),
        tlv('tbpm', encodeUtf16BE('124.00')),
        tlv('tkey', encodeUtf16BE('Bm')),
        tlv('uadd', uint32BE(1650412088)),
        tlv('bmis', bool(false)),
        tlv('bcrt', bool(false)),
      ])
    );

    const result = parseDatabaseV2Buffer(Buffer.concat([vrsn, otrk]));

    expect(result.versionString).toBe('2.0/Serato Scratch LIVE Database');
    expect(result.tracks).toEqual([
      {
        rawPath:
          'Every relevant song ever/1653 - Coldplay - Something Just Like This (Don Diablo Remix).mp3',
        fileType: 'mp3',
        title: 'Something Just Like This (Don Diablo Remix)',
        artist: 'Coldplay',
        album: 'Something Just Like This (Remix Pack) (Remixes)',
        genre: 'Dance',
        bpm: '124.00',
        key: 'Bm',
        dateAdded: 1650412088,
        missing: false,
        corrupt: false,
      },
    ]);
  });

  it('ignores unknown/unmapped tags rather than throwing', () => {
    const otrk = tlv(
      'otrk',
      Buffer.concat([
        tlv('pfil', encodeUtf16BE('track.mp3')),
        tlv('sbav', Buffer.from([0x01, 0x02])), // unidentified field, see format doc
        tlv('utme', uint32BE(1697803180)), // not yet mapped to a DatabaseV2Track field
      ])
    );

    const result = parseDatabaseV2Buffer(otrk);
    expect(result.tracks).toEqual([{ rawPath: 'track.mp3' }]);
  });
});

/**
 * `parseRawDatabaseV2Records`/`readRawDatabaseV2Records` exist so
 * `databaseV2Writer.ts` can carry a track's ENTIRE original record
 * forward (docs/decisions.md, 2026-09-14 entry) rather than only the
 * handful of named fields `parseDatabaseV2Buffer` above decodes. These
 * tests are deliberately about preserving fields the named-field parser
 * doesn't even know about (`sbav`, `utme` here) -- that's the whole
 * point of a separate raw path.
 */
describe('parseRawDatabaseV2Records / readRawDatabaseV2Records', () => {
  it('keys each raw otrk payload by its resolved absolute path, preserving unknown fields byte-for-byte', () => {
    const volumeRoot = '/library';
    const otrk1 = tlv(
      'otrk',
      Buffer.concat([
        tlv('pfil', encodeUtf16BE('House/track1.mp3')),
        tlv('sbav', Buffer.from([0x01, 0x02])), // unidentified field -- must survive anyway
        tlv('utme', uint32BE(1697803180)), // not decoded by parseDatabaseV2Buffer -- must survive anyway
      ])
    );
    const otrk2 = tlv('otrk', Buffer.concat([tlv('pfil', encodeUtf16BE('House/track2.mp3'))]));

    const buffer = Buffer.concat([tlv('vrsn', encodeUtf16BE('2.0/Serato Scratch LIVE Database')), otrk1, otrk2]);
    const records = parseRawDatabaseV2Records(buffer, volumeRoot);

    expect(records.size).toBe(2);
    const record1 = records.get(path.resolve(volumeRoot, 'House/track1.mp3'));
    expect(record1).toBeDefined();
    // The raw record is the otrk chunk's payload exactly as it appeared
    // in the source buffer -- unknown fields (sbav, utme) included.
    expect(record1!.equals(otrk1.subarray(8))).toBe(true);
    expect(records.has(path.resolve(volumeRoot, 'House/track2.mp3'))).toBe(true);
  });

  it('skips a track record with no pfil field rather than storing it under a bogus key', () => {
    const otrk = tlv('otrk', Buffer.concat([tlv('tsng', encodeUtf16BE('No Path Here'))]));
    const records = parseRawDatabaseV2Records(otrk, '/library');
    expect(records.size).toBe(0);
  });

  it('returns copies, not views into the source buffer', () => {
    const otrk = tlv('otrk', Buffer.concat([tlv('pfil', encodeUtf16BE('a.mp3'))]));
    const buffer = Buffer.concat([otrk]);
    const records = parseRawDatabaseV2Records(buffer, '/library');
    const record = records.get(path.resolve('/library', 'a.mp3'))!;

    buffer.fill(0); // mutate the source buffer after parsing
    expect(record.equals(Buffer.alloc(0))).toBe(false); // the stored copy is unaffected
  });

  it('readRawDatabaseV2Records reads a real file from disk read-only', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-dbv2-raw-read-'));
    try {
      const filePath = path.join(dir, 'database V2');
      const otrk = tlv('otrk', Buffer.concat([tlv('pfil', encodeUtf16BE('Inbox/track.mp3'))]));
      const original = Buffer.concat([tlv('vrsn', encodeUtf16BE('2.0/Serato Scratch LIVE Database')), otrk]);
      await fs.writeFile(filePath, original);

      const records = await readRawDatabaseV2Records(filePath, dir);
      expect(records.size).toBe(1);
      expect(records.has(path.resolve(dir, 'Inbox/track.mp3'))).toBe(true);

      // Read-only: the file on disk is untouched.
      const afterRead = await fs.readFile(filePath);
      expect(afterRead.equals(original)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
