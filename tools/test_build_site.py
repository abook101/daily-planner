"""Checks that the public website only gets app files, and that no private file
(Whoop settings, login tokens, certificates, Whoop data) is tracked by git.

    python tools/test_build_site.py
"""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_site  # noqa: E402

PRIVATE = ("sync/config.json", "sync/tokens.json", "sync/whoop-data.json", "sync/certs/", ".env")


class TestSite(unittest.TestCase):
    def setUp(self):
        self.out = Path(tempfile.mkdtemp()) / "_site"

    def tearDown(self):
        shutil.rmtree(self.out.parent, ignore_errors=True)

    def test_site_has_the_app_and_nothing_private(self):
        files = build_site.build(out=self.out)
        for must in ("index.html", "sw.js", "manifest.webmanifest", "js/app.js", "js/sync.js",
                     "icons/apple-touch-icon.png", "privacy.html"):
            self.assertIn(must, files)
            self.assertTrue((self.out / must).is_file(), must)
        on_disk = sorted(str(p.relative_to(self.out)).replace("\\", "/") for p in self.out.rglob("*") if p.is_file())
        self.assertEqual(on_disk, sorted(files))
        for f in on_disk:
            self.assertFalse(f.startswith(("sync/", "tests/", "tools/")), f)
            self.assertFalse(f.endswith((".py", ".bat", ".key", ".crt")), f)

    def test_every_file_the_app_loads_is_published(self):
        html = (build_site.ROOT / "index.html").read_text(encoding="utf-8")
        files = build_site.app_files()
        import re
        for ref in re.findall(r'(?:src|href)="([^"#:]+)"', html):
            self.assertIn(ref, files, "index.html uses %s but sw.js doesn't list it" % ref)

    def test_version_shown_in_the_app_matches_the_offline_cache(self):
        import re
        sw = (build_site.ROOT / "sw.js").read_text(encoding="utf-8")
        app = (build_site.ROOT / "js" / "app.js").read_text(encoding="utf-8")
        cache = re.search(r'CACHE_VERSION = "planner-v(\d+)"', sw).group(1)
        shown = re.search(r'APP_VERSION = "(\d+)"', app).group(1)
        self.assertEqual(cache, shown, "Bump APP_VERSION in js/app.js together with CACHE_VERSION in sw.js")

    def test_private_files_are_not_tracked_by_git(self):
        try:
            tracked = subprocess.run(["git", "ls-files"], cwd=build_site.ROOT, capture_output=True,
                                     text=True, check=True).stdout.splitlines()
        except (OSError, subprocess.CalledProcessError):
            self.skipTest("git not available")
        for f in tracked:
            self.assertFalse(f.startswith(PRIVATE) or "token" in f.lower(), "PRIVATE FILE TRACKED: " + f)


if __name__ == "__main__":
    unittest.main(verbosity=2)
