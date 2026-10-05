"""Small CSV reader for trying the sandbox without application dependencies."""

import csv
from pathlib import Path


def read_items(filename: Path) -> list[dict[str, str]]:
    """Read the example dataset, rejecting missing fields and duplicate IDs."""
    with filename.open(encoding="utf-8", newline="") as source:
        reader = csv.DictReader(source)
        if reader.fieldnames != ["id", "name", "category"]:
            raise ValueError("Invalid CSV header")
        items = list(reader)
    identifiers = set()
    for item in items:
        if set(item) != {"id", "name", "category"} or not all(item.values()):
            raise ValueError("Invalid CSV row")
        identifier = int(item["id"])
        if identifier <= 0 or identifier in identifiers:
            raise ValueError("Invalid or duplicate ID")
        identifiers.add(identifier)
    return items


if __name__ == "__main__":
    print({"count": len(read_items(Path(__file__).parent / "data/items.csv"))})
