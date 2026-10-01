#!/usr/bin/env python3
"""Import existing www/data JSON files into SQLite (one-shot migration)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from db import (  # noqa: E402
    init_db,
    replace_semester_courses,
    upsert_catalog_courses,
    upsert_semester,
)

DATA_DIR = ROOT / "www" / "data"


def import_catalog(path: Path) -> int:
    with open(path, encoding="utf-8") as handle:
        courses = json.load(handle)
    return upsert_catalog_courses(courses)


def import_semester_file(path: Path, season: str, year: int) -> int:
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    term_code = payload.get("term_code") or ""
    if not term_code:
        if season == "fall":
            term_code = f"{year + 1}10"
        elif season == "spring":
            term_code = f"{year}20"
        elif season == "summer":
            term_code = f"{year}30"
    label = payload.get("semester_name") or f"{season.capitalize()} {year}"
    semester_id = upsert_semester(season, year, term_code=term_code, label=label)
    return replace_semester_courses(semester_id, payload.get("courses") or [])


def main() -> None:
    parser = argparse.ArgumentParser(description="Import www/data JSON into SQLite.")
    parser.add_argument(
        "--catalog",
        type=Path,
        default=DATA_DIR / "full_catalog.json",
        help="Path to full_catalog.json",
    )
    parser.add_argument(
        "--semester",
        nargs=2,
        metavar=("SEASON", "YEAR"),
        action="append",
        help="Import www/data/<season>_<year>.json (repeatable)",
    )
    parser.add_argument(
        "--all-semesters",
        action="store_true",
        help="Import every www/data/<season>_<year>.json found",
    )
    args = parser.parse_args()

    init_db()

    if args.catalog.exists():
        count = import_catalog(args.catalog)
        print(f"Imported {count} catalog courses from {args.catalog}")
    else:
        print(f"Catalog not found at {args.catalog}; skipping")

    targets: list[tuple[str, int, Path]] = []
    if args.all_semesters:
        for path in sorted(DATA_DIR.glob("*_*.json")):
            if path.name == "full_catalog.json":
                continue
            stem = path.stem  # fall_2026
            parts = stem.rsplit("_", 1)
            if len(parts) != 2 or not parts[1].isdigit():
                continue
            season, year_s = parts
            if season not in ("spring", "summer", "fall"):
                continue
            targets.append((season, int(year_s), path))
    for item in args.semester or []:
        season, year_s = item[0].lower(), item[1]
        path = DATA_DIR / f"{season}_{year_s}.json"
        targets.append((season, int(year_s), path))

    for season, year, path in targets:
        if not path.exists():
            print(f"Missing {path}; skipping")
            continue
        count = import_semester_file(path, season, year)
        print(f"Imported {count} courses for {season} {year} from {path}")

    if not targets and not args.catalog.exists():
        print("Nothing to import.")
        sys.exit(1)


if __name__ == "__main__":
    main()
