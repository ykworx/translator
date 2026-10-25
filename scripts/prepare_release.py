#!/usr/bin/env python3
"""Synchronize app versions from tauri.conf.json, without resolving dependencies."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
try:
    import tomllib
except ModuleNotFoundError:
    raise SystemExit("Release preparation requires Python 3.11 or newer")

# Release preparation must not add untracked bytecode to the source tree.
sys.dont_write_bytecode = True
from check_release_version import cargo_root_package, check_versions, stable_version


def replace_json_values(text: str, paths: list[tuple[str, ...]], version: str) -> str:
    """Replace only the requested string tokens, preserving all other bytes."""
    decoder = json.JSONDecoder()
    spans: list[tuple[int, int]] = []

    def whitespace(index: int) -> int:
        while index < len(text) and text[index] in " \t\r\n":
            index += 1
        return index

    def walk(index: int, path: tuple[str, ...]) -> int:
        index = whitespace(index)
        if path in paths:
            value, end = decoder.raw_decode(text, index)
            if not isinstance(value, str):
                raise ValueError("Version fields must be strings")
            spans.append((index, end))
            return end
        if text[index] != "{" or not any(candidate[:len(path)] == path for candidate in paths):
            return decoder.raw_decode(text, index)[1]
        cursor = whitespace(index + 1)
        while text[cursor] != "}":
            key, cursor = decoder.raw_decode(text, cursor)
            cursor = whitespace(cursor)
            if text[cursor] != ":":
                raise ValueError("Invalid JSON object")
            cursor = whitespace(walk(cursor + 1, path + (key,)))
            if text[cursor] == "}":
                break
            if text[cursor] != ",":
                raise ValueError("Invalid JSON object")
            cursor = whitespace(cursor + 1)
        return cursor + 1

    walk(0, ())
    if len(spans) != len(paths):
        raise ValueError("Missing app version field")
    for start, end in sorted(spans, reverse=True):
        text = text[:start] + json.dumps(version) + text[end:]
    return text


def replace_toml_version(text: str, version: str) -> str:
    matches = list(re.finditer(r"(?m)^([ \t]*version[ \t]*=[ \t]*)([^\r\n]+)", text))
    if len(matches) != 1:
        raise ValueError("Expected one literal version field in the app package section")
    match = matches[0]
    # Existing TOML has already been parsed; retain a trailing comment if present.
    value = match.group(2)
    literal = re.fullmatch(r"([\"'])(.*?)\1([ \t]*(?:#.*)?)", value)
    if literal is None:
        raise ValueError("App package version must use a single-line quoted string")
    return text[:match.start(2)] + json.dumps(version) + literal.group(3) + text[match.end(2):]


def replace_cargo_manifest(text: str, version: str) -> str:
    sections = list(re.finditer(r"(?m)^\[.*$", text))
    for index, section in enumerate(sections):
        if re.fullmatch(r"\[package\][ \t]*(?:#.*)?\r?", section.group()):
            end = sections[index + 1].start() if index + 1 < len(sections) else len(text)
            return text[:section.start()] + replace_toml_version(text[section.start():end], version) + text[end:]
    raise ValueError("Cargo.toml is missing [package]")


def replace_cargo_lock(text: str, name: str, version: str) -> str:
    sections = list(re.finditer(r"(?m)^\[.*$", text))
    matches: list[tuple[int, int]] = []
    for index, section in enumerate(sections):
        if not re.fullmatch(r"\[\[package\]\][ \t]*(?:#.*)?\r?", section.group()):
            continue
        end = sections[index + 1].start() if index + 1 < len(sections) else len(text)
        package = tomllib.loads(text[section.start():end])["package"][0]
        if package.get("name") == name and "source" not in package:
            matches.append((section.start(), end))
    if len(matches) != 1:
        raise ValueError("Cargo.lock must contain exactly one source-free root app package")
    start, end = matches[0]
    return text[:start] + replace_toml_version(text[start:end], version) + text[end:]


def atomic_write(path: Path, data: bytes) -> None:
    mode = stat.S_IMODE(path.stat().st_mode)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            os.fchmod(output.fileno(), mode)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        parent = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def prepare_release(root: Path, version: str | None = None) -> str:
    names = ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json"]
    paths = [root / name for name in names]
    if any(path.is_symlink() for path in paths):
        raise ValueError("Release manifests must be regular files, not symlinks")
    originals = {path: path.read_bytes() for path in paths}
    texts = {path: data.decode("utf-8") for path, data in originals.items()}
    package, npm_lock = (json.loads(texts[root / name]) for name in names[:2])
    cargo = tomllib.loads(texts[root / "src-tauri/Cargo.toml"])
    cargo_lock = tomllib.loads(texts[root / "src-tauri/Cargo.lock"])
    tauri = json.loads(texts[root / "src-tauri/tauri.conf.json"])
    target = stable_version(tauri["version"] if version is None else version)
    # Validate every target before modifying any file. Other versions may drift;
    # this command repairs that drift while preserving dependency declarations.
    cargo_root_package(cargo, cargo_lock)
    if not isinstance(package["version"], str) or not isinstance(npm_lock["version"], str):
        raise ValueError("Version fields must be strings")
    planned = {
        paths[0]: replace_json_values(texts[paths[0]], [("version",)], target),
        paths[1]: replace_json_values(texts[paths[1]], [("version",), ("packages", "", "version")], target),
        paths[2]: replace_cargo_manifest(texts[paths[2]], target),
        paths[3]: replace_cargo_lock(texts[paths[3]], cargo["package"]["name"], target),
        paths[4]: replace_json_values(texts[paths[4]], [("version",)], target),
    }
    changed: list[Path] = []
    try:
        for path, text in planned.items():
            data = text.encode("utf-8")
            if data != originals[path]:
                # Include the current file in rollback even if rename succeeded
                # and its directory sync subsequently reported an error.
                changed.append(path)
                atomic_write(path, data)
        check_versions(root)
    except (OSError, ValueError, KeyError, TypeError):
        rollback_errors: list[str] = []
        for path in reversed(changed):
            try:
                atomic_write(path, originals[path])
            except OSError:
                rollback_errors.append(str(path.relative_to(root)))
        if rollback_errors:
            raise OSError("Version preparation failed; inspect partially restored manifests: " + ", ".join(rollback_errors)) from None
        raise
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--version", help="Stable X.Y.Z; omit to synchronize from tauri.conf.json")
    args = parser.parse_args()
    try:
        print("Release version prepared: " + prepare_release(args.root, args.version))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f"Release preparation: {error}\n")


if __name__ == "__main__":
    main()
