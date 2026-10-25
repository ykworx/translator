import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from release_fixtures import SCRIPTS, make_project
import check_release_version as check
import prepare_release as prepare


class PrepareReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        make_project(self.root)

    def files(self):
        return {path.relative_to(self.root): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}

    def test_requested_version_updates_every_projection_and_only_version_tokens(self):
        before = self.files()
        self.assertEqual(prepare.prepare_release(self.root, "0.3.0"), "0.3.0")
        self.assertEqual(check.check_versions(self.root, "v0.3.0"), "0.3.0")
        after = self.files()
        for name in ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]:
            path = Path(name)
            self.assertEqual(after[path], before[path].replace(b'version = "1.2.3" # app', b'version = "0.3.0" # app'))
        package = json.loads(after[Path("package.json")])
        lock = json.loads(after[Path("package-lock.json")])
        self.assertEqual(package["dependencies"], {"example": "1.2.3"})
        self.assertEqual(package["scripts"], {"test": "vitest"})
        self.assertEqual(lock["packages"]["node_modules/example"], {"version": "1.2.3", "integrity": "unchanged"})
        self.assertEqual(set(before), set(after))

    def test_canonical_tauri_version_repairs_other_manifest_drift_without_an_argument(self):
        path = self.root / "src-tauri/tauri.conf.json"
        path.write_text('{"version":"2.3.4","identifier":"unchanged"}\n')
        self.assertEqual(prepare.prepare_release(self.root), "2.3.4")
        self.assertEqual(check.check_versions(self.root), "2.3.4")
        self.assertEqual(path.read_text(), '{"version":"2.3.4","identifier":"unchanged"}\n')

    def test_json_whitespace_and_unrelated_matching_versions_are_preserved(self):
        path = self.root / "package.json"
        original = '{ "dependencies": {"x":"1.2.3"}, "version" : "1.2.3", "description":"日本語" }\r\n'
        path.write_bytes(original.encode())
        prepare.prepare_release(self.root, "0.3.0")
        self.assertEqual(path.read_bytes(), original.replace('"version" : "1.2.3"', '"version" : "0.3.0"').encode())

    def test_repeated_preparation_is_a_noop(self):
        prepare.prepare_release(self.root, "0.3.0")
        with patch.object(prepare, "atomic_write", side_effect=AssertionError("must not rewrite identical files")):
            self.assertEqual(prepare.prepare_release(self.root, "0.3.0"), "0.3.0")

    def test_invalid_stable_versions_leave_all_files_unchanged(self):
        before = self.files()
        for version in ["v0.3.0", "0.3", "00.3.0", "0.03.0", "0.3.00", "0.3.0-rc.1", "0.3.0+build.1", "0.3.0\n"]:
            with self.subTest(version=version), self.assertRaises(ValueError):
                prepare.prepare_release(self.root, version)
            self.assertEqual(self.files(), before)

    def test_missing_lock_root_is_detected_before_any_write(self):
        (self.root / "src-tauri/Cargo.lock").write_text('version=3\n[[package]]\nname="example"\nversion="1.2.3"\n')
        before = self.files()
        with self.assertRaises(ValueError):
            prepare.prepare_release(self.root, "0.3.0")
        self.assertEqual(self.files(), before)

    def test_missing_npm_root_version_is_detected_before_any_write(self):
        path = self.root / "package-lock.json"
        value = json.loads(path.read_text())
        del value["packages"][""]["version"]
        path.write_text(json.dumps(value))
        before = self.files()
        with self.assertRaises(ValueError):
            prepare.prepare_release(self.root, "0.3.0")
        self.assertEqual(self.files(), before)

    def test_failure_after_a_replacement_restores_all_original_files(self):
        before = self.files()
        real_write = prepare.atomic_write
        count = 0

        def interrupted(path, data):
            nonlocal count
            count += 1
            real_write(path, data)
            if count == 2:
                raise OSError("injected directory sync failure after replacement")

        with patch.object(prepare, "atomic_write", side_effect=interrupted):
            with self.assertRaises(OSError):
                prepare.prepare_release(self.root, "0.3.0")
        self.assertEqual(self.files(), before)
        self.assertEqual(check.check_versions(self.root), "1.2.3")

    def test_prepare_cli_operates_only_on_the_supplied_fixture_root(self):
        result = subprocess.run([sys.executable, str(SCRIPTS / "prepare_release.py"), "--root", str(self.root), "--version", "0.3.0"],
                                capture_output=True, text=True, check=True)
        self.assertIn("Release version prepared: 0.3.0", result.stdout)
        self.assertEqual(check.check_versions(self.root), "0.3.0")


if __name__ == "__main__":
    unittest.main()
