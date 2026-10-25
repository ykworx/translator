#!/usr/bin/env python3
"""Validate local app versions; optionally require an exact stable vX.Y.Z tag."""
import argparse
import json
from pathlib import Path
import re
try:
    import tomllib
except ModuleNotFoundError:
    raise SystemExit("Release version check requires Python 3.11 or newer")

STABLE = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")


def check_versions(root: Path, tag: str = "") -> str:
    package = json.loads((root / "package.json").read_text())
    lock = json.loads((root / "package-lock.json").read_text())
    cargo = tomllib.loads((root / "src-tauri/Cargo.toml").read_text())
    tauri = json.loads((root / "src-tauri/tauri.conf.json").read_text())
    values = {
        "package.json": package["version"],
        "package-lock.json": lock["version"],
        "package-lock.json root package": lock["packages"][""]["version"],
        "Cargo.toml": cargo["package"]["version"],
        "tauri.conf.json": tauri["version"],
    }
    version = values["package.json"]
    if not isinstance(version, str) or STABLE.fullmatch(version) is None:
        raise ValueError("Expected stable X.Y.Z app version")
    if any(value != version for value in values.values()):
        raise ValueError("Version mismatch: " + ", ".join(f"{key}={value}" for key, value in values.items()))
    if tag and tag != "v" + version:
        raise ValueError(f"Tag {tag!r} must exactly match v{version}")
    return version


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--tag", default="")
    args = parser.parse_args()
    try:
        print("Version verified: " + check_versions(args.root, args.tag))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f"Release version check: {error}\n")


if __name__ == "__main__":
    main()

