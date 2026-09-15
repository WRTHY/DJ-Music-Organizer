"""Tests for editing export.pdb: in-place field edits, adding tracks,
and adding playlist entries.

Every edit must produce a file that (a) our own parser reads back with
the expected contents and (b) leaves everything else untouched.
"""

from pathlib import Path

import pytest

from rekordbox_pdb import Database
from rekordbox_pdb.edit import PdbEditor

DATA = Path(__file__).parent / "data"
ONE_SONG = DATA / "one-song-export.pdb"
BIGGER = DATA / "bigger-export.pdb"


def byte_diff(a: bytes, b: bytes) -> list[int]:
    assert len(a) == len(b)
    return [i for i, (x, y) in enumerate(zip(a, b)) if x != y]


class TestInPlaceEdits:
    def test_set_rating(self, tmp_path):
        ed = PdbEditor.from_file(ONE_SONG)
        ed.set_track_field(1, "rating", 5)
        out = tmp_path / "edited.pdb"
        ed.save(out)

        db = Database.from_file(out)
        (track,) = db.tracks
        assert track.rating == 5
        assert track.title == "Super Smash Bros."  # untouched

    def test_set_rating_changes_exactly_one_byte(self, tmp_path):
        ed = PdbEditor.from_file(ONE_SONG)
        ed.set_track_field(1, "rating", 5)
        out = tmp_path / "edited.pdb"
        ed.save(out)
        assert len(byte_diff(ONE_SONG.read_bytes(), out.read_bytes())) == 1

    def test_set_play_count_and_color(self, tmp_path):
        ed = PdbEditor.from_file(BIGGER)
        ed.set_track_field(3, "play_count", 42)
        ed.set_track_field(3, "color_id", 2)
        out = tmp_path / "edited.pdb"
        ed.save(out)

        db = Database.from_file(out)
        track = next(t for t in db.tracks if t.id == 3)
        assert track.play_count == 42
        assert track.color_id == 2

    def test_unknown_field_rejected(self):
        ed = PdbEditor.from_file(ONE_SONG)
        with pytest.raises(KeyError):
            ed.set_track_field(1, "title", "nope")  # strings aren't fixed fields

    def test_unknown_track_rejected(self):
        ed = PdbEditor.from_file(ONE_SONG)
        with pytest.raises(LookupError):
            ed.set_track_field(999, "rating", 5)


class TestAddTrack:
    def test_add_track_minimal(self, tmp_path):
        ed = PdbEditor.from_file(ONE_SONG)
        tid = ed.add_track(
            title="Test Song",
            file_path="/Contents/Test Artist/Test Album/Test Song.mp3",
        )
        out = tmp_path / "edited.pdb"
        ed.save(out)

        db = Database.from_file(out)
        assert len(db.tracks) == 2
        track = next(t for t in db.tracks if t.id == tid)
        assert track.title == "Test Song"
        assert track.file_path == "/Contents/Test Artist/Test Album/Test Song.mp3"
        assert track.filename == "Test Song.mp3"  # derived from path

    def test_add_track_full_metadata(self, tmp_path):
        ed = PdbEditor.from_file(ONE_SONG)
        tid = ed.add_track(
            title="Test Song",
            file_path="/Contents/A/B/Test Song.mp3",
            artist="Test Artist",
            album="Test Album",
            genre="House",
            key="Am",
            tempo=12800,
            duration=200,
            year=2026,
            bitrate=320,
            sample_rate=44100,
            file_size=8_000_000,
            track_number=3,
        )
        out = tmp_path / "edited.pdb"
        ed.save(out)

        db = Database.from_file(out)
        track = next(t for t in db.tracks if t.id == tid)
        assert (track.tempo, track.duration, track.year) == (12800, 200, 2026)
        assert (track.bitrate, track.sample_rate) == (320, 44100)

        # New lookup rows were created and are referenced correctly.
        assert {a.id: a.name for a in db.artists}[track.artist_id] == "Test Artist"
        assert {a.id: a.name for a in db.albums}[track.album_id] == "Test Album"
        assert {g.id: g.name for g in db.genres}[track.genre_id] == "House"
        assert {k.id: k.name for k in db.keys}[track.key_id] == "Am"

    def test_add_track_reuses_existing_lookups(self, tmp_path):
        ed = PdbEditor.from_file(ONE_SONG)
        tid = ed.add_track(
            title="Another Gravy Song",
            file_path="/Contents/BABY GRAVY/x/y.mp3",
            artist="BABY GRAVY",  # already exists with id 2
            key="Em",  # already exists with id 1
        )
        out = tmp_path / "edited.pdb"
        ed.save(out)

        db = Database.from_file(out)
        track = next(t for t in db.tracks if t.id == tid)
        assert track.artist_id == 2
        assert track.key_id == 1
        assert len(db.artists) == 2  # nothing new created
        assert len(db.keys) == 1

    def test_add_track_does_not_disturb_existing_data(self, tmp_path):
        ed = PdbEditor.from_file(BIGGER)
        ed.add_track(title="New", file_path="/Contents/a/b/New.mp3")
        out = tmp_path / "edited.pdb"
        ed.save(out)

        before = Database.from_file(BIGGER)
        after = Database.from_file(out)
        assert {t.id: t.title for t in before.tracks}.items() <= {
            t.id: t.title for t in after.tracks}.items()
        assert [(a.id, a.name) for a in before.artists] == [
            (a.id, a.name) for a in after.artists]
        assert sorted(
            (e.playlist_id, e.entry_index, e.track_id)
            for e in before.playlist_entries
        ) == sorted(
            (e.playlist_id, e.entry_index, e.track_id)
            for e in after.playlist_entries
        )

    def test_add_track_unicode_title(self, tmp_path):
        ed = PdbEditor.from_file(ONE_SONG)
        tid = ed.add_track(
            title="Stavöstranos — épreuve",
            file_path="/Contents/a/b/c.mp3",
        )
        out = tmp_path / "edited.pdb"
        ed.save(out)
        db = Database.from_file(out)
        track = next(t for t in db.tracks if t.id == tid)
        assert track.title == "Stavöstranos — épreuve"


class TestPlaylists:
    def test_add_track_to_existing_playlist(self, tmp_path):
        ed = PdbEditor.from_file(ONE_SONG)
        tid = ed.add_track(title="New", file_path="/Contents/a/b/New.mp3")
        ed.add_to_playlist(1, tid)  # playlist "aac"
        out = tmp_path / "edited.pdb"
        ed.save(out)

        db = Database.from_file(out)
        entries = sorted(
            (e for e in db.playlist_entries if e.playlist_id == 1),
            key=lambda e: e.entry_index,
        )
        assert [e.track_id for e in entries] == [1, tid]
        assert [e.entry_index for e in entries] == [1, 2]

    def test_create_playlist_and_fill_it(self, tmp_path):
        ed = PdbEditor.from_file(BIGGER)
        pid = ed.create_playlist("claude mix")
        for tid in (1, 5, 9):
            ed.add_to_playlist(pid, tid)
        out = tmp_path / "edited.pdb"
        ed.save(out)

        db = Database.from_file(out)
        node = next(n for n in db.playlist_tree if n.id == pid)
        assert node.name == "claude mix"
        assert not node.is_folder
        assert node.parent_id == 0
        entries = sorted(
            (e for e in db.playlist_entries if e.playlist_id == pid),
            key=lambda e: e.entry_index,
        )
        assert [e.track_id for e in entries] == [1, 5, 9]

    def test_add_to_unknown_playlist_rejected(self):
        ed = PdbEditor.from_file(ONE_SONG)
        with pytest.raises(LookupError):
            ed.add_to_playlist(99, 1)


class TestPageOverflow:
    def test_add_many_tracks_spills_to_new_pages(self, tmp_path):
        """Track rows are a few hundred bytes; dozens of them cannot fit in
        the one existing data page, so page allocation must work."""
        ed = PdbEditor.from_file(ONE_SONG)
        ids = [
            ed.add_track(
                title=f"Bulk Track {i:03d}",
                file_path=f"/Contents/Bulk/Album/{i:03d}.mp3",
                artist=f"Bulk Artist {i % 7}",
            )
            for i in range(50)
        ]
        out = tmp_path / "edited.pdb"
        ed.save(out)

        db = Database.from_file(out)
        assert len(db.tracks) == 51
        by_id = {t.id: t for t in db.tracks}
        assert len(ids) == len(set(ids))
        for i, tid in enumerate(ids):
            assert by_id[tid].title == f"Bulk Track {i:03d}"
        artists = {a.id: a.name for a in db.artists}
        for tid in ids:
            assert artists[by_id[tid].artist_id].startswith("Bulk Artist")

    def test_playlist_with_hundreds_of_entries(self, tmp_path):
        ed = PdbEditor.from_file(BIGGER)
        pid = ed.create_playlist("everything, many times")
        for n in range(400):
            ed.add_to_playlist(pid, (n % 12) + 1)
        out = tmp_path / "edited.pdb"
        ed.save(out)

        db = Database.from_file(out)
        entries = [e for e in db.playlist_entries if e.playlist_id == pid]
        assert len(entries) == 400
        assert sorted(e.entry_index for e in entries) == list(range(1, 401))


class TestFailureAtomicity:
    """Errors must surface *before* any mutation, leaving the editor usable."""

    def test_oversized_row_rejected_cleanly(self, tmp_path):
        ed = PdbEditor.from_file(ONE_SONG)
        before = bytes(ed._buf)
        with pytest.raises(ValueError):
            ed.add_track(title="x" * 5000, file_path="/Contents/a/b/c.mp3")
        assert bytes(ed._buf) == before  # untouched, still usable
        tid = ed.add_track(title="fine", file_path="/Contents/a/b/fine.mp3")
        out = tmp_path / "ok.pdb"
        ed.save(out)
        assert any(t.id == tid for t in Database.from_file(out).tracks)

    def test_out_of_range_field_value_rejected_before_write(self):
        ed = PdbEditor.from_file(ONE_SONG)
        with pytest.raises(ValueError):
            ed.set_track_field(1, "rating", 300)  # u8 field
        (track,) = ed.db.tracks
        assert track.rating == 4  # original value intact

    def test_add_track_with_bad_numeric_creates_no_orphan_rows(self):
        ed = PdbEditor.from_file(ONE_SONG)
        with pytest.raises(ValueError):
            ed.add_track(
                title="t", file_path="/Contents/a/b/c.mp3",
                artist="Orphan Artist", year=70000,  # u16 overflow
            )
        assert all(a.name != "Orphan Artist" for a in ed.db.artists)
