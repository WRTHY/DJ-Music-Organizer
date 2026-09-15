"""Verification against large USB captures that live outside this repo.

These tests provide the heavyweight evidence — a 713-track real-world
export and a field-by-field diff against the independent Kaitai/crate-digger
parser — but depend on captures that aren't shipped with the library. Point
``REKORDBOX_PDB_CAPTURES`` at a directory laid out as::

    $REKORDBOX_PDB_CAPTURES/house-keys/PIONEER/rekordbox/export.pdb
    $REKORDBOX_PDB_CAPTURES/house-keys/PIONEER/rekordbox/exportExt.pdb
    $REKORDBOX_PDB_CAPTURES/speedboxsync/rekordbox_pdb.py   # Kaitai parser

to enable them; otherwise they skip.
"""

import importlib.util
import os
from pathlib import Path

import pytest

from rekordbox_pdb import Database, ExtDatabase

CAPTURES = Path(os.environ.get("REKORDBOX_PDB_CAPTURES", "/nonexistent"))
HOUSE_KEYS = CAPTURES / "house-keys/PIONEER/rekordbox/export.pdb"
HOUSE_KEYS_EXT = CAPTURES / "house-keys/PIONEER/rekordbox/exportExt.pdb"
KAITAI_DIR = CAPTURES / "speedboxsync"


@pytest.fixture(scope="module")
def db():
    return Database.from_file(HOUSE_KEYS)


@pytest.mark.skipif(not HOUSE_KEYS.exists(), reason="house-keys USB capture not present")
class TestHouseKeys:

    def test_full_library_parses(self, db):
        assert len(db.tracks) == 713
        for track in db.tracks:
            assert track.file_path.startswith("/Contents/")
            assert track.analyze_path.startswith("/PIONEER/USBANLZ/")

    def test_lookups_resolve(self, db):
        artists = {a.id: a.name for a in db.artists}
        keys = {k.id: k.name for k in db.keys}
        for track in db.tracks:
            if track.artist_id:
                assert track.artist_id in artists
            if track.key_id:
                assert track.key_id in keys

    def test_playlists_reference_tracks(self, db):
        track_ids = {t.id for t in db.tracks}
        assert len(db.playlist_tree) == 10
        for entry in db.playlist_entries:
            assert entry.track_id in track_ids

    def test_pages_with_more_than_255_slots(self, db):
        """Pages that ever held >255 row slots encode the count as
        nrs = n & 0xFF plus an overflow bit — the widely-used
        'num_rows_large' heuristic silently drops rows there.

        Counts verified independently via the directory-size equation
        2n + 4*ceil(n/16) == page_size - 0x28 - used - free and the
        present-count field (u16@0x19 >> 5) on every page.
        """
        assert len(db.playlist_entries) == 717
        assert len(db.history_entries) == 281
        track_ids = {t.id for t in db.tracks}
        for entry in db.history_entries:
            assert entry.track_id in track_ids

    def test_ext_default_tags(self):
        ext = ExtDatabase.from_file(HOUSE_KEYS_EXT)
        assert {t.name for t in ext.tags if t.is_category} == {
            "Genre", "Components", "Situation", "Untitled Column",
        }


@pytest.mark.skipif(
    not (KAITAI_DIR / "rekordbox_pdb.py").exists(),
    reason="Kaitai reference parser not present",
)
def test_differential_against_kaitai_parser(capsys):
    """Every comparable field must agree with the crate-digger spec parser."""
    spec = importlib.util.spec_from_file_location(
        "kaitai_pdb", KAITAI_DIR / "rekordbox_pdb.py"
    )
    assert spec is not None and spec.loader is not None
    import sys

    sys.path.insert(0, str(KAITAI_DIR))  # for its bundled kaitaistruct.py
    try:
        kaitai_pdb = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(kaitai_pdb)
    finally:
        sys.path.remove(str(KAITAI_DIR))

    path = Path(__file__).parent / "data/bigger-export.pdb"
    mine = Database.from_file(path)
    theirs = kaitai_pdb.RekordboxPdb.from_file(str(path))
    theirs._read()
    capsys.readouterr()  # swallow the reference parser's debug prints

    def k_string(s):
        return s.body.text

    def k_rows(table):
        rows = []
        page = table.first_page.body
        while True:
            if page.is_data_page:
                for group in page.row_groups:
                    rows.extend(r.body for r in group.rows if r.present)
            if page.page_index == table.last_page.index:
                break
            page = page.next_page.body
        return rows

    by_type = {int(t.type.value): t for t in theirs.tables}

    kaitai_tracks = sorted(k_rows(by_type[0]), key=lambda t: t.id)
    my_tracks = sorted(mine.tracks, key=lambda t: t.id)
    assert len(my_tracks) == len(kaitai_tracks)
    for m, k in zip(my_tracks, kaitai_tracks):
        assert m.id == k.id
        assert m.title == k_string(k.title)
        assert m.file_path == k_string(k.file_path)
        assert (m.tempo, m.duration, m.year, m.rating) == (
            k.tempo, k.duration, k.year, k.rating)
        assert (m.artist_id, m.album_id, m.genre_id, m.key_id) == (
            k.artist_id, k.album_id, k.genre_id, k.key_id)

    assert {a.id: a.name for a in mine.artists} == {
        k.id: k_string(k.name) for k in k_rows(by_type[2])}
    assert {a.id: a.name for a in mine.albums} == {
        k.id: k_string(k.name) for k in k_rows(by_type[3])}
    assert sorted((e.playlist_id, e.entry_index, e.track_id)
                  for e in mine.playlist_entries) == sorted(
        (k.playlist_id, k.entry_index, k.track_id) for k in k_rows(by_type[8]))
