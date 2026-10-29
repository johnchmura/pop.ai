"""Advisor data kept in Pop's SQLite database (data/pop.db).

Pop's own tables hold the catalog (catalog_courses) and the sections (semesters, courses).
The advisor adds one key-value table for what Pop does not have:
  departments      subject code -> department name
  catalog_source   where the catalog text came from
  prereq_fixes     hand-checked prerequisite trees for unclear catalog wording, plus notes
  forecast         the CS department's tentative future offerings
  programs         the checked degree programs (requirement groups)
  semester         the semester the schedule and plans use, for example "Spring 2027"
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from app.db import (
    ROOT,
    connect,
    init_db,
    replace_semester_courses,
    upsert_catalog_courses,
    upsert_semester,
)

SEED_DIR = ROOT / "seed"

ADVISOR_SQL = """
CREATE TABLE IF NOT EXISTS advisor_data (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def init_advisor(conn: sqlite3.Connection) -> sqlite3.Connection:
    init_db(conn)
    conn.executescript(ADVISOR_SQL)
    conn.commit()
    return conn


def open_db(db_path: Path | None = None) -> sqlite3.Connection:
    return init_advisor(connect(db_path))


def get_value(conn: sqlite3.Connection, key: str, default: Any = None) -> Any:
    row = conn.execute("SELECT value FROM advisor_data WHERE key = ?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def set_value(conn: sqlite3.Connection, key: str, value: Any) -> None:
    conn.execute(
        "INSERT INTO advisor_data (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value, ensure_ascii=False)),
    )


def _read(name: str) -> Any:
    return json.loads((SEED_DIR / name).read_text(encoding="utf-8"))


def seed(conn: sqlite3.Connection, *, catalog: bool = True, sections: bool = True) -> dict[str, int]:
    """Load seed/ into the database. Catalog and sections already scraped by Pop can be kept."""
    init_advisor(conn)
    counts: dict[str, int] = {}
    advisor = _read("advisor.json")
    set_value(conn, "departments", advisor["departments"])
    set_value(conn, "catalog_source", advisor["catalogSource"])
    set_value(conn, "prereq_fixes", advisor["prereqFixes"])
    set_value(conn, "semester", advisor["semester"])
    set_value(conn, "forecast", _read("forecast.json"))
    programs = _read("programs.json")["programs"]
    set_value(conn, "programs", programs)
    conn.commit()
    counts["programs"] = len(programs)
    if catalog:
        counts["catalog"] = upsert_catalog_courses(_read("catalog.json"), conn=conn)
    if sections:
        for path in sorted(SEED_DIR.glob("*_*.json")):
            season, _, year = path.stem.partition("_")
            if season not in ("spring", "summer", "fall") or not year.isdigit():
                continue
            payload = json.loads(path.read_text(encoding="utf-8"))
            semester_id = upsert_semester(season, int(year), term_code=payload.get("term_code", ""), label=payload.get("semester_name"), conn=conn)
            counts[path.stem] = replace_semester_courses(semester_id, payload.get("courses") or [], conn=conn)
    return counts


def is_seeded(conn: sqlite3.Connection) -> bool:
    init_advisor(conn)
    return get_value(conn, "programs") is not None
