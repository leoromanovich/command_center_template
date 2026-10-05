"""Checks for the small CSV example."""

import tempfile
import unittest
from pathlib import Path

from catalog import read_items


class CatalogTests(unittest.TestCase):
    def read(self, contents):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "items.csv"
            filename.write_text(contents, encoding="utf-8")
            return read_items(filename)

    def test_synthetic_dataset(self):
        filename = Path.cwd() / "data/items.csv"
        self.assertEqual(len(read_items(filename)), 6)

    def test_empty_dataset(self):
        self.assertEqual(self.read("id,name,category\n"), [])

    def test_invalid_header(self):
        with self.assertRaises(ValueError):
            self.read("id,name\n1,Apple\n")

    def test_duplicate_ids(self):
        with self.assertRaises(ValueError):
            self.read("id,name,category\n1,A,food\n1,B,food\n")

    def test_invalid_rows(self):
        for row in ["0,A,food", "1,A", "1,A,food,extra", "1,,food"]:
            with self.subTest(row=row), self.assertRaises(ValueError):
                self.read("id,name,category\n" + row + "\n")
