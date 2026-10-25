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


def stable_version(value: object) -> str:
    if not isinstance(value, str) or STABLE.fullmatch(value) is None:
        raise ValueError("Expected stable X.Y.Z app version without a v prefix or suffix")
    return value


def cargo_root_package(cargo: dict, lock: dict) -> dict:
    name = cargo["package"]["name"]
    if not isinstance(name, str) or not name:
        raise ValueError("Cargo.toml must name the root app package")
    packages = lock.get("package")
    if not isinstance(packages, list) or any(not isinstance(package, dict) for package in packages):
        raise ValueError("Cargo.lock must contain the root app package")
    matches = [package for package in packages if package.get("name") == name and "source" not in package]
    if len(matches) != 1:
        raise ValueError("Cargo.lock must contain exactly one source-free root app package")
    return matches[0]


def check_versions(root: Path, tag: str = "") -> str:
    package = json.loads((root / "package.json").read_text())
    lock = json.loads((root / "package-lock.json").read_text())
    cargo = tomllib.loads((root / "src-tauri/Cargo.toml").read_text())
    cargo_lock = tomllib.loads((root / "src-tauri/Cargo.lock").read_text())
    tauri = json.loads((root / "src-tauri/tauri.conf.json").read_text())
    values = {
        "package.json": package["version"],
        "package-lock.json": lock["version"],
        "package-lock.json root package": lock["packages"][""]["version"],
        "Cargo.toml": cargo["package"]["version"],
        "Cargo.lock root app": cargo_root_package(cargo, cargo_lock)["version"],
        "tauri.conf.json": tauri["version"],
    }
    # Tauri owns the product version; npm and Cargo are synchronized projections.
    version = stable_version(values["tauri.conf.json"])
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

