from pathlib import Path
import sys

for file in Path(sys.argv[1]).rglob("*.md"):
    text = file.read_text(encoding="utf-8")
    assert text.startswith("# "), f"{file}: missing title"
    assert text.endswith("\n"), f"{file}: missing final newline"
    assert "\x00" not in text, f"{file}: binary data"
print("Knowledge Markdown checks passed")
