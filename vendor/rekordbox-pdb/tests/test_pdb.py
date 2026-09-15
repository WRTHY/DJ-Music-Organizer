"""Tests against real rekordbox USB exports.

These encode what a correct reverse-engineering of the export.pdb format
must produce: values independently verified by hand against hex dumps and
against what rekordbox displayed for this library (track "Super Smash" by
BABY GRAVY from the album "Baby Gravy 3", exported 2024-02-29).
"""

from pathlib import Path

import pytest

from rekordbox_pdb import Database, TableType

DATA = Path(__file__).parent / "data"
ONE_SONG = DATA / "one-song-export.pdb"
BIGGER = DATA / "bigger-export.pdb"


@pytest.fixture(scope="module")
def db() -> Database:
    return Database.from_file(ONE_SONG)


class TestFileStructure:
    """The container: 4KB pages, table directory in the file header."""

    def test_header(self, db):
        assert db.page_size == 4096
        assert len(db.tables) == 20

    def test_all_20_table_types_present_exactly_once(self, db):
        # This export contains one table of each known type, 0..19.
        assert sorted(t.type for t in db.tables) == list(range(20))


class TestTracks:
    def test_single_track_fixed_fields(self, db):
        (track,) = db.tracks
        assert track.id == 1
        assert track.tempo == 14600  # BPM * 100 -> 146.00
        assert track.year == 2023
        assert track.duration == 153  # seconds (2:33)
        assert track.rating == 4
        assert track.sample_rate == 48000
        assert track.sample_depth == 16
        assert track.bitrate == 128
        assert track.file_size == 2561982
        assert track.track_number == 2
        assert track.disc_number == 1
        assert track.artist_id == 1
        assert track.album_id == 1
        assert track.key_id == 1
        assert track.artwork_id == 1

    def test_single_track_strings(self, db):
        (track,) = db.tracks
        assert track.title == "Super Smash Bros."
        assert track.filename == "BABY GRAVY, Yung Gravy, bbno$ - Super Smash .mp3"
        assert track.file_path == (
            "/Contents/BABY GRAVY_Yung Gravy_bbno$/Baby Gravy 3/"
            "BABY GRAVY, Yung Gravy, bbno$ - Super Smash .mp3"
        )
        assert track.analyze_path == "/.PIONEER/USBANLZ/P011/00005719/ANLZ0000.DAT"
        assert track.date_added == "2023-10-21"
        assert track.analyze_date == "2024-02-29"


class TestLookupTables:
    def test_artists(self, db):
        names = {a.id: a.name for a in db.artists}
        assert names == {1: "BABY GRAVY/Yung Gravy/bbno$", 2: "BABY GRAVY"}

    def test_albums(self, db):
        (album,) = db.albums
        assert album.id == 1
        assert album.name == "Baby Gravy 3"
        assert album.artist_id == 2

    def test_keys(self, db):
        (key,) = db.keys
        assert key.id == 1
        assert key.name == "Em"

    def test_colors(self, db):
        names = {c.id: c.name for c in db.colors}
        assert names == {
            1: "Pink", 2: "Red", 3: "Orange", 4: "Yellow",
            5: "Green", 6: "Aqua", 7: "Blue", 8: "Purple",
        }


class TestPlaylists:
    def test_tree(self, db):
        (node,) = db.playlist_tree
        assert node.id == 1
        assert node.name == "aac"
        assert node.parent_id == 0
        assert not node.is_folder

    def test_entries(self, db):
        (entry,) = db.playlist_entries
        assert entry.playlist_id == 1
        assert entry.track_id == 1
        assert entry.entry_index == 1


class TestColumns:
    """Column-name table uses long UTF-16LE strings wrapped in U+FFFA/U+FFFB."""

    def test_genre_column(self, db):
        names = {c.id: c.name for c in db.columns}
        assert names[1] == "￺GENRE￻"
        assert names[2] == "￺ARTIST￻"


@pytest.fixture(scope="module")
def big() -> Database:
    return Database.from_file(BIGGER)


class TestBiggerExport:
    """Smoke test on a full multi-track library export."""

    def test_parses_many_tracks(self, big):
        assert len(big.tracks) > 10
        for track in big.tracks:
            # Every track must have a decodable title and absolute file path.
            assert isinstance(track.title, str)
            assert track.file_path.startswith("/")

    def test_referential_integrity(self, big):
        artist_ids = {a.id for a in big.artists}
        for track in big.tracks:
            if track.artist_id:
                assert track.artist_id in artist_ids

    def test_playlist_entries_reference_real_tracks(self, big):
        track_ids = {t.id for t in big.tracks}
        for entry in big.playlist_entries:
            assert entry.track_id in track_ids


class TestGenericAccess:
    def test_rows_by_table_type(self, db):
        rows = db.rows(TableType.TRACKS)
        assert len(rows) == 1


class TestRowLocations:
    """The editor needs to know where each row lives in the file."""

    def test_track_row_location(self, db):
        locs = db.row_locations(TableType.TRACKS)
        assert locs == [2 * 4096 + 0x210]  # hand-verified from the hex dump

    def test_locations_parallel_rows(self, db):
        for table_type in (TableType.ARTISTS, TableType.COLORS,
                           TableType.PLAYLIST_ENTRIES):
            assert len(db.row_locations(table_type)) == len(db.rows(table_type))
