"""Tests for exportExt.pdb — the companion database holding My Tag data.

The row layout for the tag table was reverse engineered in this project
from hex dumps of two independent exports (both contain rekordbox's
default My Tag setup: categories Genre / Components / Situation /
Untitled Column with 24 tags between them).
"""

from pathlib import Path

import pytest

from rekordbox_pdb import ExtDatabase, ExtTableType

DATA = Path(__file__).parent / "data"
ONE_SONG_EXT = DATA / "one-song-exportExt.pdb"


@pytest.fixture(scope="module")
def ext() -> ExtDatabase:
    return ExtDatabase.from_file(ONE_SONG_EXT)


class TestExtStructure:
    def test_header(self, ext):
        assert ext.page_size == 4096
        assert len(ext.tables) == 9
        assert sorted(t.type for t in ext.tables) == list(range(9))


class TestMyTags:
    def test_default_categories(self, ext):
        cats = {t.id: t.name for t in ext.tags if t.is_category}
        assert cats == {
            1: "Genre", 2: "Components", 3: "Situation", 4: "Untitled Column",
        }

    def test_categories_are_ordered(self, ext):
        positions = {t.name: t.position for t in ext.tags if t.is_category}
        assert positions == {
            "Genre": 0, "Components": 1, "Situation": 2, "Untitled Column": 3,
        }

    def test_default_genre_tags_in_order(self, ext):
        genre_tags = sorted(
            (t for t in ext.tags if not t.is_category and t.category_id == 1),
            key=lambda t: t.position,
        )
        assert [t.name for t in genre_tags] == [
            "Acid House", "Deep House", "Techno", "Nu Disco",
            "Electro House", "Bass Music", "Trap",
        ]

    def test_every_tag_belongs_to_a_category(self, ext):
        category_ids = {t.id for t in ext.tags if t.is_category}
        for tag in ext.tags:
            if not tag.is_category:
                assert tag.category_id in category_ids

    def test_tag_ids_are_stable_nonzero(self, ext):
        # Tag ids are persistent 32-bit values assigned by rekordbox
        # (identical across independent exports of the same tag names).
        acid = next(t for t in ext.tags if t.name == "Acid House")
        assert acid.id == 0x91A5E419

    def test_28_default_rows(self, ext):
        assert len(ext.rows(ExtTableType.TAGS)) == 28
