import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/check_release_version.py"
spec = importlib.util.spec_from_file_location("check_release_version", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class VersionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "src-tauri").mkdir()
        (self.root / "package.json").write_text('{"version":"1.2.3"}')
        (self.root / "package-lock.json").write_text(
            '{"version":"1.2.3","packages":{"":{"version":"1.2.3"}}}')
        (self.root / "src-tauri/Cargo.toml").write_text('[package]\nname="tauri-app"\nversion="1.2.3"\n')
        (self.root / "src-tauri/Cargo.lock").write_text('version=3\n[[package]]\nname="tauri-app"\nversion="1.2.3"\n')
        (self.root / "src-tauri/tauri.conf.json").write_text('{"version":"1.2.3"}')

    def test_versions_without_tag(self):
        self.assertEqual(module.check_versions(self.root), "1.2.3")

    def test_exact_tag(self):
        self.assertEqual(module.check_versions(self.root, "v1.2.3"), "1.2.3")

    def test_other_version_tag_rejected(self):
        with self.assertRaises(ValueError):
            module.check_versions(self.root, "v1.2.4")

    def test_tag_without_v_rejected(self):
        with self.assertRaises(ValueError):
            module.check_versions(self.root, "1.2.3")

    def test_suffix_tag_rejected(self):
        with self.assertRaises(ValueError):
            module.check_versions(self.root, "v1.2.3-beta.1")

    def test_tauri_drift_rejected(self):
        (self.root / "src-tauri/tauri.conf.json").write_text('{"version":"1.2.4"}')
        with self.assertRaises(ValueError):
            module.check_versions(self.root)

    def test_cargo_drift_rejected(self):
        (self.root / "src-tauri/Cargo.toml").write_text('[package]\nname="tauri-app"\nversion="1.2.4"\n')
        with self.assertRaises(ValueError):
            module.check_versions(self.root)

    def test_lock_root_package_drift_rejected(self):
        lock = self.root / "package-lock.json"
        value = json.loads(lock.read_text())
        value["packages"][""]["version"] = "1.2.4"
        lock.write_text(json.dumps(value))
        with self.assertRaises(ValueError):
            module.check_versions(self.root)

    def test_cargo_lock_root_app_drift_rejected(self):
        (self.root / "src-tauri/Cargo.lock").write_text('version=3\n[[package]]\nname="tauri-app"\nversion="1.2.4"\n')
        with self.assertRaises(ValueError):
            module.check_versions(self.root)

    def test_ambiguous_cargo_lock_root_app_rejected(self):
        path = self.root / "src-tauri/Cargo.lock"
        path.write_text(path.read_text() + '\n[[package]]\nname="tauri-app"\nversion="1.2.3"\n')
        with self.assertRaises(ValueError):
            module.check_versions(self.root)

    def test_registry_dependency_with_root_name_is_not_the_app(self):
        path = self.root / "src-tauri/Cargo.lock"
        path.write_text(path.read_text() + '\n[[package]]\nname="tauri-app"\nversion="9.9.9"\nsource="registry+https://example.invalid"\n')
        self.assertEqual(module.check_versions(self.root), "1.2.3")

    def test_malformed_lock_package_list_is_rejected(self):
        (self.root / "src-tauri/Cargo.lock").write_text('version=3\npackage=["not a package table"]\n')
        with self.assertRaises(ValueError):
            module.check_versions(self.root)

    def test_stable_version_format_is_strict(self):
        for version in ["v1.2.3", "1.2", "01.2.3", "1.02.3", "1.2.03", "1.2.3-beta.1", "1.2.3+build", " 1.2.3", "1.2.3\n", 123, None]:
            with self.subTest(version=version), self.assertRaises(ValueError):
                module.stable_version(version)


if __name__ == "__main__":
    unittest.main()

