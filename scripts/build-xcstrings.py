#!/usr/bin/env python3
"""Builds the iOS String Catalogs from per-area JSON fragments (DESIGN.md §10.1).

Sources (the only files translators and agents edit):
  ios/RacketCoach/Resources/Strings/<area>.json      -> Localizable.xcstrings
  ios/RacketCoach/Resources/Strings/InfoPlist.json   -> InfoPlist.xcstrings (Info.plist keys, e.g. NSCameraUsageDescription)

Generated (never edit by hand):
  ios/RacketCoach/Resources/Strings/tips.json        from TIP_KEYS in supabase/functions/_shared/contracts/common.ts
                                                     and the tip tables in docs/camera-guide.{en,vi}.md (appendix)
  ios/RacketCoach/Resources/Localizable.xcstrings
  ios/RacketCoach/Resources/InfoPlist.xcstrings

Fragment format: one JSON object per file, keys sorted or not, each entry
    "home.analyze": {"en": "Analyze a stroke", "vi": "Phân tích cú đánh", "comment": "Main button on Home"}
  * `comment` (translator note) is required; `en` and `vi` are required and non-empty.
  * A plural entry uses an object of CLDR categories instead of a string, with `other` required, e.g.
    "en": {"one": "%lld analysis left", "other": "%lld analyses left"}. A plural string takes exactly one
    integer argument (%lld / %d). Vietnamese has no plural forms, so "vi" is normally a plain string.
  * Format specifiers (%@, %lld, %1$@ ...) must match between en and vi.
  * Keys are lowercase dotted semantic keys (`area.thing.detail`); InfoPlist.json uses Info.plist key names.
  * Top-level keys starting with "_" are file metadata and are ignored.

Usage:
  python3 scripts/build-xcstrings.py           # regenerate tips.json and both catalogs
  python3 scripts/build-xcstrings.py --check   # exit 1 if anything is invalid or out of date (CI)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
RESOURCES = REPO / "ios" / "RacketCoach" / "Resources"
FRAGMENTS = RESOURCES / "Strings"
LOCALIZABLE = RESOURCES / "Localizable.xcstrings"
INFOPLIST = RESOURCES / "InfoPlist.xcstrings"
TIPS_FRAGMENT = FRAGMENTS / "tips.json"
COMMON_TS = REPO / "supabase" / "functions" / "_shared" / "contracts" / "common.ts"
CAMERA_GUIDE = {"en": REPO / "docs" / "camera-guide.en.md", "vi": REPO / "docs" / "camera-guide.vi.md"}

LANGUAGES = ("en", "vi")
SOURCE_LANGUAGE = "en"
PLURAL_CATEGORIES = ("zero", "one", "two", "few", "many", "other")
KEY_RE = re.compile(r"^[a-z0-9_]+(\.[a-z0-9_]+)+$")
INFOPLIST_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
# printf-style specifiers as used by String(format:) and String Catalogs.
FORMAT_RE = re.compile(r"%(?:(\d+)\$)?[-+ 0#]*\d*(?:\.\d+)?(hh|h|ll|l|q|z|t|j)?([@dDuUxXoOfeEgGcCsSpaAF%])")
INT_CONVERSIONS = set("dDuUxXoO")


class FragmentError(Exception):
    pass


# ---------------------------------------------------------------------------------------------------------------------
# Formatting helpers

def dump_json(obj: object) -> str:
    """Xcode's String Catalog layout: 2-space indent, `" : "` separators, sorted keys, UTF-8, trailing newline."""
    return json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True, separators=(",", " : ")) + "\n"


def dump_fragment(obj: object) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def format_specs(text: str) -> list[str]:
    """Normalized list of format specifiers (positional index + conversion), ignoring `%%`."""
    specs = []
    implicit = 0
    for match in FORMAT_RE.finditer(text):
        position, length, conversion = match.groups()
        if conversion == "%":
            continue
        if position is None:
            implicit += 1
            position = str(implicit)
        kind = "int" if conversion in INT_CONVERSIONS else ("obj" if conversion == "@" else conversion)
        specs.append(f"{position}:{kind}")
    return sorted(specs)


def variants(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [v for v in value.values() if isinstance(v, str)]
    return []


# ---------------------------------------------------------------------------------------------------------------------
# tips.json (generated from the contracts and the camera guide)

def parse_tip_keys() -> list[str]:
    text = COMMON_TS.read_text(encoding="utf-8")
    match = re.search(r"export const TIP_KEYS\s*=\s*\[(.*?)\]\s*as const", text, re.S)
    if not match:
        raise FragmentError(f"{COMMON_TS.relative_to(REPO)}: TIP_KEYS not found")
    keys = re.findall(r"'([^']+)'|\"([^\"]+)\"", match.group(1))
    return [a or b for a, b in keys]


def parse_guide_tips(language: str) -> dict[str, str]:
    path = CAMERA_GUIDE[language]
    tips: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        row = re.match(r"^\|\s*`(camera\.tip\.[a-z0-9_]+)`\s*\|\s*(.+?)\s*\|\s*$", line)
        if row:
            tips[row.group(1)] = row.group(2).strip()
    return tips


def build_tips_fragment() -> dict:
    keys = parse_tip_keys()
    copy = {lang: parse_guide_tips(lang) for lang in LANGUAGES}
    fragment: dict[str, object] = {
        "_generated": "by scripts/build-xcstrings.py from TIP_KEYS (contracts/common.ts) and the tip tables in "
        "docs/camera-guide.{en,vi}.md. Edit the camera guide, not this file.",
    }
    missing = []
    for key in keys:
        entry: dict[str, str] = {
            "comment": "Recording tip shown after a rejected clip and in the camera guide (contracts TIP_KEYS).",
        }
        for lang in LANGUAGES:
            text = copy[lang].get(key)
            if not text:
                missing.append(f"{key} ({lang})")
                continue
            entry[lang] = text
        fragment[key] = entry
    if missing:
        raise FragmentError("camera guide appendix has no copy for: " + ", ".join(missing))
    extra = sorted((set(copy["en"]) | set(copy["vi"])) - set(keys))
    if extra:
        raise FragmentError("camera guide appendix lists keys that are not in TIP_KEYS: " + ", ".join(extra))
    return fragment


# ---------------------------------------------------------------------------------------------------------------------
# Fragments → catalogs

def validate_entry(path: Path, key: str, entry: object, infoplist: bool) -> list[str]:
    where = f"{path.relative_to(REPO)}: {key}"
    errors = []
    key_re = INFOPLIST_KEY_RE if infoplist else KEY_RE
    if not key_re.match(key):
        errors.append(f"{where}: key must match {key_re.pattern}")
    if not isinstance(entry, dict):
        return errors + [f"{where}: entry must be an object with en, vi and comment"]
    unknown = set(entry) - {"en", "vi", "comment"}
    if unknown:
        errors.append(f"{where}: unknown fields {sorted(unknown)}")
    comment = entry.get("comment")
    if not isinstance(comment, str) or not comment.strip():
        errors.append(f"{where}: translator comment is required")
    specs: dict[str, list[str]] = {}
    for lang in LANGUAGES:
        value = entry.get(lang)
        if isinstance(value, str):
            if not value.strip():
                errors.append(f"{where}: {lang} is empty")
            specs[lang] = format_specs(value)
        elif isinstance(value, dict):
            if "other" not in value:
                errors.append(f"{where}: {lang} plural needs an 'other' form")
            bad = set(value) - set(PLURAL_CATEGORIES)
            if bad:
                errors.append(f"{where}: {lang} plural has unknown categories {sorted(bad)}")
            forms = [v for v in value.values()]
            if not all(isinstance(v, str) and v.strip() for v in forms):
                errors.append(f"{where}: {lang} plural forms must be non-empty strings")
                continue
            form_specs = {tuple(format_specs(v)) for v in forms if format_specs(v)}
            if len(form_specs) > 1:
                errors.append(f"{where}: {lang} plural forms use different format arguments")
            all_specs = format_specs(value["other"]) if isinstance(value.get("other"), str) else []
            if len(all_specs) != 1 or not all_specs[0].endswith(":int"):
                errors.append(f"{where}: {lang} plural must take exactly one integer argument (%lld)")
            specs[lang] = all_specs
        else:
            errors.append(f"{where}: missing {lang}")
    if len(specs) == 2 and specs["en"] != specs["vi"]:
        errors.append(f"{where}: format arguments differ between en {specs['en']} and vi {specs['vi']}")
    return errors


def string_unit(value: str) -> dict:
    return {"stringUnit": {"state": "translated", "value": value}}


def localization(value: object) -> dict:
    if isinstance(value, str):
        return string_unit(value)
    return {"variations": {"plural": {category: string_unit(text) for category, text in value.items()}}}


def load_fragments(tips: dict) -> tuple[dict[str, dict], dict[str, dict], list[str]]:
    errors: list[str] = []
    localizable: dict[str, dict] = {}
    infoplist: dict[str, dict] = {}
    origin: dict[str, Path] = {}
    files = sorted(p for p in FRAGMENTS.glob("*.json"))
    contents: list[tuple[Path, dict]] = []
    for path in files:
        if path == TIPS_FRAGMENT:
            contents.append((path, tips))
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(f"{path.relative_to(REPO)}: invalid JSON ({exc})")
            continue
        if not isinstance(data, dict):
            errors.append(f"{path.relative_to(REPO)}: must be a JSON object")
            continue
        contents.append((path, data))
    if TIPS_FRAGMENT not in files:
        contents.append((TIPS_FRAGMENT, tips))
    for path, data in contents:
        is_infoplist = path.stem == "InfoPlist"
        target = infoplist if is_infoplist else localizable
        for key, entry in data.items():
            if key.startswith("_"):
                continue
            entry_errors = validate_entry(path, key, entry, is_infoplist)
            if entry_errors:
                errors.extend(entry_errors)
                continue
            if key in target:
                errors.append(
                    f"{path.relative_to(REPO)}: {key} is already defined in {origin[key].relative_to(REPO)}"
                )
                continue
            origin[key] = path
            target[key] = {
                "comment": entry["comment"].strip(),
                "extractionState": "manual",
                "localizations": {lang: localization(entry[lang]) for lang in LANGUAGES},
            }
    return localizable, infoplist, errors


def catalog(strings: dict[str, dict]) -> dict:
    return {"sourceLanguage": SOURCE_LANGUAGE, "strings": strings, "version": "1.0"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="validate and fail if a generated file is stale")
    args = parser.parse_args()

    try:
        tips = build_tips_fragment()
    except FragmentError as exc:
        print(f"build-xcstrings: {exc}", file=sys.stderr)
        return 1
    localizable, infoplist, errors = load_fragments(tips)
    if errors:
        for error in errors:
            print(f"build-xcstrings: {error}", file=sys.stderr)
        return 1

    outputs = {
        TIPS_FRAGMENT: dump_fragment(tips),
        LOCALIZABLE: dump_json(catalog(localizable)),
        INFOPLIST: dump_json(catalog(infoplist)),
    }
    stale = []
    for path, text in outputs.items():
        current = path.read_text(encoding="utf-8") if path.exists() else None
        if current == text:
            continue
        if args.check:
            stale.append(path)
        else:
            path.write_text(text, encoding="utf-8")
            print(f"build-xcstrings: wrote {path.relative_to(REPO)}")
    if stale:
        for path in stale:
            print(
                f"build-xcstrings: {path.relative_to(REPO)} is out of date (or was edited by Xcode); "
                "run python3 scripts/build-xcstrings.py",
                file=sys.stderr,
            )
        return 1
    print(f"build-xcstrings: OK ({len(localizable)} Localizable keys, {len(infoplist)} InfoPlist keys)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
