import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from release_fixtures import make_project
import check_packaged_app as packaged


class PackagedAppTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        make_project(self.root)
        self.app = self.root / "Transrator.app"
        (self.app / "Contents/MacOS").mkdir(parents=True)
        self.executable = self.app / "Contents/MacOS/transrator"
        self.executable.write_text("fixture only; subprocess is mocked\n")
        self.metadata = {"CFBundleShortVersionString": "1.2.3", "CFBundleVersion": "123.1", "CFBundleExecutable": "transrator"}
        self.write_plist()
        self.info = {"version": "1.2.3", "revision": "a" * 40, "dirty": False, "channel": "validation",
                     "builtAtUnixSeconds": 1700000000, "buildNumber": "123.1"}

    def write_plist(self):
        (self.app / "Contents/Info.plist").write_bytes(plistlib.dumps(self.metadata))

    def check(self, **kwargs):
        arguments = {"root": self.root, "app": self.app, "build_number": "123.1", "channel": "validation", "revision": "a" * 40}
        arguments.update(kwargs)
        return packaged.check_packaged_app(**arguments)

    def fake_binary(self):
        return patch.object(packaged.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(self.info), ""))

    def test_packaged_plist_and_native_metadata_match_the_release(self):
        with self.fake_binary() as run:
            self.assertEqual(self.check(tag="v1.2.3"), self.info)
        run.assert_called_once_with([str(self.executable.resolve()), "--build-info"], check=True,
                                    capture_output=True, text=True, encoding="utf-8", timeout=10)

    def test_plist_version_and_build_drift_are_rejected_before_execution(self):
        for key, value in [("CFBundleShortVersionString", "1.2.4"), ("CFBundleVersion", "123.2")]:
            with self.subTest(key=key):
                previous = self.metadata[key]
                self.metadata[key] = value
                self.write_plist()
                with self.fake_binary() as run, self.assertRaises(ValueError):
                    self.check()
                run.assert_not_called()
                self.metadata[key] = previous

    def test_native_version_channel_number_revision_and_dirty_drift_are_rejected(self):
        for key, value in [("version", "1.2.4"), ("channel", "release"), ("buildNumber", "123.2"),
                           ("revision", "b" * 40), ("dirty", True), ("dirty", "false"),
                           ("builtAtUnixSeconds", True), ("builtAtUnixSeconds", -1)]:
            with self.subTest(key=key, value=value):
                previous = self.info[key]
                self.info[key] = value
                with self.fake_binary(), self.assertRaises(ValueError):
                    self.check()
                self.info[key] = previous

    def test_build_number_bounds_are_strict(self):
        for value in ["0.1", "1.0", "001.1", "1.01", "10000.1", "1.100", "1", "1.2.3", "1.1\n"]:
            with self.subTest(value=value), self.fake_binary() as run, self.assertRaises(ValueError):
                self.check(build_number=value)
            run.assert_not_called()
        self.metadata["CFBundleVersion"] = "9999.99"
        self.write_plist()
        self.info["buildNumber"] = "9999.99"
        with self.fake_binary():
            self.check(build_number="9999.99")

    def test_development_can_report_dirty_without_hiding_it(self):
        self.info.update(channel="development", dirty=True)
        with self.fake_binary():
            self.assertTrue(self.check(channel="development")["dirty"])

    def test_optional_revision_is_typed_even_when_no_revision_is_required(self):
        self.info["revision"] = None
        with self.fake_binary():
            self.check(revision=None)
        self.info["revision"] = "short"
        with self.fake_binary(), self.assertRaises(ValueError):
            self.check(revision=None)

    def test_bad_executable_paths_are_never_executed(self):
        for name in ["../transrator", "/usr/bin/python3", "nested/tool", "..", ""]:
            self.metadata["CFBundleExecutable"] = name
            self.write_plist()
            with self.subTest(name=name), self.fake_binary() as run, self.assertRaises(ValueError):
                self.check()
            run.assert_not_called()

    def test_logs_instead_of_one_json_object_and_command_timeouts_fail_closed(self):
        for stdout in ["boot log\n{}", "[]", "not json"]:
            with self.subTest(stdout=stdout), patch.object(packaged.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout, "")), self.assertRaises(ValueError):
                self.check()
        with patch.object(packaged.subprocess, "run", side_effect=subprocess.TimeoutExpired("fixture", 10)), self.assertRaises(ValueError):
            self.check()


if __name__ == "__main__":
    unittest.main()
