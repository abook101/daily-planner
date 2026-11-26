"""Copies ONLY the app's files into _site/ for the public website (GitHub Pages).

The list of files comes from sw.js (the files the phone stores for offline use),
plus sw.js itself and privacy.html. Nothing from sync/ or tests/ is ever copied,
so the laptop program, its settings and your Whoop data can't end up on the site.

    python tools/build_site.py          -> makes _site/
"""
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXTRA = ["sw.js", "privacy.html"]
NEVER = ("sync/", "tests/", "tools/", ".git", ".env", "backups/")


def app_files(root=ROOT):
    text = (root / "sw.js").read_text(encoding="utf-8")
    block = re.search(r"const FILES = \[(.*?)\];", text, re.S)
    if not block:
        raise SystemExit("Couldn't find the FILES list in sw.js")
    files = [f for f in re.findall(r'"([^"]+)"', block.group(1)) if f != "./"]
    return files + [f for f in EXTRA if f not in files]


def build(root=ROOT, out=None):
    out = Path(out or root / "_site")
    if out.exists():
        shutil.rmtree(out)
    copied = []
    for rel in app_files(root):
        if rel.startswith(NEVER) or ".." in rel or rel.endswith(".json") and "manifest" not in rel:
            raise SystemExit("Refusing to publish %s" % rel)
        src = root / rel
        if not src.is_file():
            raise SystemExit("sw.js lists %s but the file doesn't exist" % rel)
        dst = out / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        copied.append(rel)
    return copied


if __name__ == "__main__":
    files = build()
    print("Website files in _site/ (%d):" % len(files))
    for f in files:
        print("  " + f)
    sys.exit(0)
