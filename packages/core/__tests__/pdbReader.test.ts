import { parsePdbTracks } from '../src/rekordbox/pdbReader';

const PAGE_SIZE = 4096;
const PAGE_HEADER_SIZE = 0x28;
const TRACK_ROW_FIXED_SIZE = 0x5e + 21 * 2; // fixed header through the string-offset array
const STRING_INDEX = { title: 17, fileName: 19, filePath: 20 };

/**
 * Builds a synthetic export.pdb buffer matching the format assumed by
 * pdbReader.ts (see its module doc for what that format was checked
 * against). This proves the parser is internally consistent with that
 * assumed format -- it does NOT re-prove the assumed format matches a
 * real file; that validation happened separately, against a real export
 * from James's library (see docs/decisions.md, 2026-09-08).
 */
function encodeShortString(text: string): Buffer {
  const totalLen = text.length + 1; // content + the format byte itself
  const buf = Buffer.alloc(totalLen);
  buf.writeUInt8((totalLen << 1) | 0x01, 0);
  buf.write(text, 1, 'ascii');
  return buf;
}

function encodeLongUtf16String(text: string): Buffer {
  const contentBytes = Buffer.from(text, 'utf16le');
  const buf = Buffer.alloc(4 + contentBytes.length);
  buf.writeUInt8(0x90, 0);
  buf.writeUInt16LE(4 + contentBytes.length, 1);
  // byte 3 is the documented pad byte, left as 0
  contentBytes.copy(buf, 4);
  return buf;
}

interface TrackSpec {
  id: number;
  filePath: string;
  fileName: string;
  title?: string;
  /**
   * Force individual fields to use the long/UTF-16LE encoding instead of the
   * short/ASCII one. Real non-ASCII text is only ever written this way by
   * Rekordbox -- the short encoding is ASCII-only -- so any spec field
   * containing non-ASCII characters must set the matching flag here, or the
   * test buffer itself will mangle the text before the reader ever sees it.
   */
  longTitle?: boolean;
  longFilePath?: boolean;
  longFileName?: boolean;
}

/** Builds one data page containing the given tracks, all in a single row group (max 16). */
function buildTracksPage(pageIndex: number, tracks: TrackSpec[]): Buffer {
  if (tracks.length > 16) throw new Error('test helper only supports one row group (<=16 tracks)');

  const page = Buffer.alloc(PAGE_SIZE);
  // Common + data-specific page header.
  page.writeUInt32LE(pageIndex, 0x04); // page_index
  page.writeUInt32LE(0, 0x08); // type: tracks table
  page.writeUInt32LE(0, 0x0c); // next_page (0 = end of chain)
  const rowCounts = tracks.length & 0x1fff; // low 13 bits = num_row_offsets; num_rows left as 0, unused by the reader
  page[0x18] = rowCounts & 0xff;
  page[0x19] = (rowCounts >> 8) & 0xff;
  page[0x1a] = (rowCounts >> 16) & 0xff;
  page[0x1b] = 0x00; // page_flags: not an index page

  let heapCursor = PAGE_HEADER_SIZE;
  const rowOffsets: number[] = [];

  for (const track of tracks) {
    const rowStart = heapCursor;
    const rowOffsetFromHeap = rowStart - PAGE_HEADER_SIZE;
    rowOffsets.push(rowOffsetFromHeap);

    page.writeUInt16LE(0x0024, rowStart); // subtype -- required marker for a track row
    page.writeUInt32LE(track.id, rowStart + 0x48);

    let stringCursor = rowStart + TRACK_ROW_FIXED_SIZE;
    const writeString = (index: number, text: string | undefined, long = false) => {
      if (text === undefined) return;
      const encoded = long ? encodeLongUtf16String(text) : encodeShortString(text);
      encoded.copy(page, stringCursor);
      page.writeUInt16LE(stringCursor - rowStart, rowStart + 0x5e + index * 2);
      stringCursor += encoded.length;
    };
    writeString(STRING_INDEX.filePath, track.filePath, track.longFilePath ?? false);
    writeString(STRING_INDEX.fileName, track.fileName, track.longFileName ?? false);
    writeString(STRING_INDEX.title, track.title, track.longTitle ?? false);

    heapCursor = stringCursor;
  }

  // Row group: 16 x u16 offsets (slot 0 stored last), then presence flags.
  const groupStart = PAGE_SIZE - 36;
  let presence = 0;
  rowOffsets.forEach((offset, i) => {
    page.writeUInt16LE(offset, groupStart + (15 - i) * 2);
    presence |= 1 << i;
  });
  page.writeUInt16LE(presence, groupStart + 32);

  return page;
}

function buildPdb(pages: Buffer[]): Buffer {
  const buffer = Buffer.alloc(PAGE_SIZE * (pages.length + 1)); // +1 for the file header "page"
  buffer.writeUInt32LE(PAGE_SIZE, 0x04);
  buffer.writeUInt32LE(1, 0x08); // num_tables
  // One table pointer: type=0 (tracks), first_page=1.
  buffer.writeUInt32LE(0, 0x1c); // type
  buffer.writeUInt32LE(1, 0x1c + 8); // first_page

  pages.forEach((page, i) => page.copy(buffer, PAGE_SIZE * (i + 1)));
  return buffer;
}

describe('parsePdbTracks', () => {
  it('extracts a track using the short-string encoding for every field', () => {
    const page = buildTracksPage(1, [
      { id: 42, filePath: '/Contents/Phazed/Wildfire/50 - Phazed - Wildfire.mp3', fileName: '50 - Phazed - Wildfire.mp3', title: 'Wildfire' },
    ]);
    const tracks = parsePdbTracks(buildPdb([page]));

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toEqual({
      id: 42,
      filePath: '/Contents/Phazed/Wildfire/50 - Phazed - Wildfire.mp3',
      fileName: '50 - Phazed - Wildfire.mp3',
      title: 'Wildfire',
    });
  });

  it('extracts a track using the long UTF-16LE encoding, including non-ASCII text', () => {
    const page = buildTracksPage(1, [
      {
        id: 7,
        filePath: '/Contents/NTO/La clé des champs/14 - NTO - La clé des champs.mp3',
        fileName: '14 - NTO - La clé des champs.mp3',
        title: 'La clé des champs',
        // All three fields contain the non-ASCII 'é' here, so all three need
        // the long/UTF-16LE encoding -- the short encoding is ASCII-only and
        // would silently mangle it (this is what the original test bug was).
        longTitle: true,
        longFilePath: true,
        longFileName: true,
      },
    ]);
    const tracks = parsePdbTracks(buildPdb([page]));

    expect(tracks).toHaveLength(1);
    expect(tracks[0].title).toBe('La clé des champs');
    expect(tracks[0].filePath).toContain('clé');
  });

  it('extracts multiple tracks from the same page, in row order', () => {
    const page = buildTracksPage(1, [
      { id: 1, filePath: '/Contents/A/a.mp3', fileName: 'a.mp3' },
      { id: 2, filePath: '/Contents/B/b.mp3', fileName: 'b.mp3' },
      { id: 3, filePath: '/Contents/C/c.mp3', fileName: 'c.mp3' },
    ]);
    const tracks = parsePdbTracks(buildPdb([page]));
    expect(tracks.map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it('follows the page chain across multiple pages', () => {
    const page1 = buildTracksPage(1, [{ id: 1, filePath: '/Contents/A/a.mp3', fileName: 'a.mp3' }]);
    const page2 = buildTracksPage(2, [{ id: 2, filePath: '/Contents/B/b.mp3', fileName: 'b.mp3' }]);
    page1.writeUInt32LE(2, 0x0c); // page 1's next_page -> page 2

    const tracks = parsePdbTracks(buildPdb([page1, page2]));
    expect(tracks.map((t) => t.id).sort()).toEqual([1, 2]);
  });

  it('skips index pages (no row data) without losing the rest of the chain', () => {
    const indexPage = Buffer.alloc(PAGE_SIZE);
    indexPage.writeUInt32LE(1, 0x04);
    indexPage.writeUInt32LE(0, 0x08);
    indexPage.writeUInt32LE(2, 0x0c); // next_page -> the real data page
    indexPage[0x1b] = 0x40; // index-page flag

    const dataPage = buildTracksPage(2, [{ id: 9, filePath: '/Contents/X/x.mp3', fileName: 'x.mp3' }]);

    const tracks = parsePdbTracks(buildPdb([indexPage, dataPage]));
    expect(tracks).toHaveLength(1);
    expect(tracks[0].id).toBe(9);
  });

  it('returns an empty list rather than throwing when there is no tracks table', () => {
    const buffer = Buffer.alloc(PAGE_SIZE);
    buffer.writeUInt32LE(PAGE_SIZE, 0x04);
    buffer.writeUInt32LE(0, 0x08); // num_tables = 0
    expect(parsePdbTracks(buffer)).toEqual([]);
  });
});
