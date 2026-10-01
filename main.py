#!/usr/bin/env python3
"""Pop.ai CLI: build | serve | index | import-data."""

from __future__ import annotations

import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from app.api import index_semester
from app.db import (
    init_db,
    replace_semester_courses,
    term_code,
    upsert_catalog_courses,
    upsert_semester,
)

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "www" / "data"
SRC_PATH = ROOT / "src"
SODA_JS = ROOT / "www" / "soda.js"


# --- build ---

def cmd_build(_args: argparse.Namespace) -> None:
    sources = [
        os.path.join(base, name)
        for base, _folders, files in os.walk(SRC_PATH)
        for name in files
        if name.endswith(".js")
    ]
    data = "\n".join(
        f"// {path}\n{open(path, encoding='utf-8').read()}" for path in sources
    )
    SODA_JS.write_text(data, encoding="utf-8")
    print(f"built {SODA_JS} ({len(data.splitlines())} lines)")


# --- serve ---

class _StaticHandler(BaseHTTPRequestHandler):
    def serve_file(self, path: str) -> bool:
        try:
            with open(ROOT / "www" / path.lstrip("/"), "rb") as handle:
                self.wfile.write(handle.read())
            return True
        except OSError:
            return False

    def do_GET(self) -> None:
        content_types = {
            ".css": "text/css",
            ".js": "text/javascript",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".ico": "image/vnd.microsoft.icon",
            ".txt": "text/plain",
            ".manifest": "text/cache-manifest",
        }
        content_type = "text/html"
        for suffix, mime in content_types.items():
            if self.path.endswith(suffix):
                content_type = mime
                break

        self.send_response(200, "OK")
        self.send_header("Content-Type", content_type)
        self.end_headers()

        if not self.serve_file(self.path):
            if not self.serve_file(self.path + "index.html"):
                self.wfile.write(b"<h1>Error 404</h1>")


def cmd_serve(_args: argparse.Namespace) -> None:
    print("Serving at http://localhost:8000/")
    HTTPServer(("", 8000), _StaticHandler).serve_forever()


# --- index ---

def cmd_index(args: argparse.Namespace) -> None:
    index_semester(args.semester, args.year)


# --- import-data ---

def import_catalog(path: Path) -> int:
    with open(path, encoding="utf-8") as handle:
        courses = json.load(handle)
    return upsert_catalog_courses(courses)


def import_semester_file(path: Path, season: str, year: int) -> int:
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    code = payload.get("term_code") or term_code(season, year)
    label = payload.get("semester_name") or f"{season.capitalize()} {year}"
    semester_id = upsert_semester(season, year, term_code=code, label=label)
    return replace_semester_courses(semester_id, payload.get("courses") or [])


def cmd_import_data(args: argparse.Namespace) -> None:
    init_db()
    catalog = args.catalog
    if catalog.exists():
        count = import_catalog(catalog)
        print(f"Imported {count} catalog courses from {catalog}")
    else:
        print(f"Catalog not found at {catalog}; skipping")

    targets: list[tuple[str, int, Path]] = []
    if args.all_semesters:
        for path in sorted(DATA_DIR.glob("*_*.json")):
            if path.name == "full_catalog.json":
                continue
            stem = path.stem
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

    if not targets and not catalog.exists():
        print("Nothing to import.")
        sys.exit(1)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Pop.ai tooling")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("build", help="Concatenate src/*.js into www/soda.js")

    sub.add_parser("serve", help="Serve www/ on port 8000")

    index_p = sub.add_parser("index", help="Embed a semester into sqlite-vec")
    index_p.add_argument("semester", choices=["spring", "summer", "fall"], type=str.lower)
    index_p.add_argument("year", type=int)

    import_p = sub.add_parser("import-data", help="Import www/data JSON into SQLite")
    import_p.add_argument(
        "--catalog",
        type=Path,
        default=DATA_DIR / "full_catalog.json",
        help="Path to full_catalog.json",
    )
    import_p.add_argument(
        "--semester",
        nargs=2,
        metavar=("SEASON", "YEAR"),
        action="append",
        help="Import www/data/<season>_<year>.json (repeatable)",
    )
    import_p.add_argument(
        "--all-semesters",
        action="store_true",
        help="Import every www/data/<season>_<year>.json found",
    )

    args = parser.parse_args(argv)
    if args.command == "build":
        cmd_build(args)
    elif args.command == "serve":
        cmd_serve(args)
    elif args.command == "index":
        cmd_index(args)
    elif args.command == "import-data":
        cmd_import_data(args)


if __name__ == "__main__":
    main()
