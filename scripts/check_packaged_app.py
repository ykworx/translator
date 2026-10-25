#!/usr/bin/env python3
"""Verify a macOS app's plist and native --build-info against release metadata."""
import argparse
import json
from pathlib import Path
import plistlib
import re
import subprocess
import sys

sys.dont_write_bytecode = True
from check_release_version import check_versions

BUILD_NUMBER = re.compile(r"[1-9][0-9]{0,3}\.[1-9][0-9]?")
REVISION = re.compile(r"[0-9a-fA-F]{40}")
CHANNELS = ("development", "validation", "release")


def check_packaged_app(root: Path, app: Path, build_number: str, channel: str,
                       revision: str | None = None, tag: str = "") -> dict:
    if BUILD_NUMBER.fullmatch(build_number) is None:
        raise ValueError("Build number must be RUN.ATTEMPT (run 1..9999, attempt 1..99)")
    if channel not in CHANNELS:
        raise ValueError("Unknown build channel")
    if revision is not None and REVISION.fullmatch(revision) is None:
        raise ValueError("Expected a full 40-character git revision")
    version = check_versions(root, tag)
    with (app / "Contents/Info.plist").open("rb") as source:
        metadata = plistlib.load(source)
    if not isinstance(metadata, dict):
        raise ValueError("Info.plist must contain a dictionary")
    if metadata.get("CFBundleShortVersionString") != version:
        raise ValueError("Packaged CFBundleShortVersionString does not match the canonical app version")
    if metadata.get("CFBundleVersion") != build_number:
        raise ValueError("Packaged CFBundleVersion does not match the requested build number")
    name = metadata.get("CFBundleExecutable")
    if not isinstance(name, str) or not name or name in (".", "..") or "/" in name or "\\" in name:
        raise ValueError("Info.plist must name a single bundle executable")
    executable = (app / "Contents/MacOS" / name).resolve()
    if executable.parent != (app / "Contents/MacOS").resolve() or not executable.is_file():
        raise ValueError("Packaged executable is missing or outside Contents/MacOS")
    try:
        result = subprocess.run([str(executable), "--build-info"], check=True,
                                capture_output=True, text=True, encoding="utf-8", timeout=10)
    except subprocess.SubprocessError:
        raise ValueError("Packaged executable did not return build metadata successfully") from None
    try:
        info = json.loads(result.stdout)
    except (ValueError, TypeError):
        raise ValueError("Packaged --build-info must return one JSON object") from None
    if not isinstance(info, dict):
        raise ValueError("Packaged --build-info must return one JSON object")
    if info.get("version") != version or info.get("channel") != channel or info.get("buildNumber") != build_number:
        raise ValueError("Packaged native version/channel/buildNumber does not match release metadata")
    actual_revision = info.get("revision")
    if actual_revision is not None and (not isinstance(actual_revision, str) or REVISION.fullmatch(actual_revision) is None):
        raise ValueError("Packaged revision is malformed")
    if revision is not None and (actual_revision is None or actual_revision.lower() != revision.lower()):
        raise ValueError("Packaged native revision does not match the requested git revision")
    if type(info.get("dirty")) is not bool:
        raise ValueError("Packaged dirty flag must be a boolean")
    if channel != "development" and info["dirty"]:
        raise ValueError("Validation and release bundles must be built from a clean source tree")
    timestamp = info.get("builtAtUnixSeconds")
    if type(timestamp) is not int or timestamp < 0:
        raise ValueError("Packaged build timestamp must be a non-negative integer")
    return info


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--build-number", required=True)
    parser.add_argument("--channel", choices=CHANNELS, required=True)
    parser.add_argument("--revision")
    parser.add_argument("--tag", default="")
    args = parser.parse_args()
    try:
        info = check_packaged_app(args.root, args.app, args.build_number, args.channel, args.revision, args.tag)
        print(f"Packaged app verified: {info['version']} ({info['buildNumber']}, {info['channel']})")
    except (OSError, ValueError, KeyError, TypeError, plistlib.InvalidFileException) as error:
        parser.exit(1, f"Packaged app check: {error}\n")


if __name__ == "__main__":
    main()
