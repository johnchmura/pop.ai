"""SQLite persistence for catalog, semester offerings, and sqlite-vec embeddings."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import sqlite_vec

from app.data_models import (
    CatalogCourse,
    EmbeddingRow,
    Offering,
    PopCourse,
    Semester,
    SemanticHit,
)

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = ROOT / "data" / "pop.db"
VECTOR_SIZE = 384

SCHEMA_SQL = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS catalog_courses (
    code TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    credits TEXT NOT NULL DEFAULT '',
    lecture TEXT NOT NULL DEFAULT '',
    lab TEXT NOT NULL DEFAULT '',
    prerequisites TEXT NOT NULL DEFAULT '',
    corequisites TEXT NOT NULL DEFAULT '',
    satisfies TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS semesters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season TEXT NOT NULL,
    year INTEGER NOT NULL,
    label TEXT NOT NULL UNIQUE,
    term_code TEXT NOT NULL DEFAULT '',
    scraped_at TEXT NOT NULL DEFAULT '',
    UNIQUE(season, year)
);

CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    semester_id INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
    course_name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    sections_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(semester_id, course_name)
);

CREATE TABLE IF NOT EXISTS course_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    semester_id INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
    course_name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    embedding_text TEXT NOT NULL DEFAULT '',
    UNIQUE(semester_id, course_name)
);

CREATE INDEX IF NOT EXISTS idx_courses_semester ON courses(semester_id);
CREATE INDEX IF NOT EXISTS idx_courses_name ON courses(course_name);
CREATE INDEX IF NOT EXISTS idx_embeddings_semester ON course_embeddings(semester_id);
"""

VEC_TABLE_SQL = f"""
CREATE VIRTUAL TABLE IF NOT EXISTS course_embeddings_vec USING vec0(
    embedding float[{VECTOR_SIZE}] distance_metric=cosine
);
"""


def normalize_code(code: str) -> str:
    return " ".join(str(code or "").split()).upper()


def empty_str(val: Any) -> str:
    if val is None:
        return ""
    text = str(val).strip()
    if text in ("", "-", "null", "None"):
        return ""
    return text


def catalog_attributes(entry: CatalogCourse | dict[str, Any]) -> str:
    if isinstance(entry, CatalogCourse):
        data = entry.model_dump()
    else:
        data = entry
    parts = []
    fields = [
        ("Credits", data.get("credits")),
        ("Lecture", data.get("lecture")),
        ("Lab", data.get("lab")),
        ("Prerequisite(s)", data.get("prerequisites")),
        ("Corequisite(s)", data.get("corequisites")),
        ("Satisfies", data.get("satisfies")),
    ]
    for label, value in fields:
        text = empty_str(value)
        if text:
            parts.append(f"{label}: {text}")
    if not parts:
        return ""
    return ". ".join(parts) + "."


def semester_label(season: str, year: int) -> str:
    return f"{season.capitalize()} {year}"


def term_code(season: str, year: int) -> str:
    season = season.lower()
    if season == "fall":
        return f"{year + 1}10"
    if season == "spring":
        return f"{year}20"
    if season == "summer":
        return f"{year}30"
    raise ValueError(f"Invalid semester: {season}")


def get_db_path() -> Path:
    import os

    return Path(os.getenv("POP_DB_PATH", str(DEFAULT_DB_PATH)))


def load_sqlite_vec(conn: sqlite3.Connection) -> None:
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)


def connect(db_path: Path | None = None) -> sqlite3.Connection:
    path = db_path or get_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    load_sqlite_vec(conn)
    return conn


def init_db(conn: sqlite3.Connection | None = None) -> sqlite3.Connection:
    owned = conn is None
    conn = conn or connect()
    conn.executescript(SCHEMA_SQL)
    conn.execute(VEC_TABLE_SQL)
    conn.commit()
    if owned:
        return conn
    return conn


def _ensure(conn: sqlite3.Connection | None) -> tuple[sqlite3.Connection, bool]:
    if conn is None:
        return init_db(connect()), True
    return init_db(conn), False


def serialize_vector(vector: list[float]) -> bytes:
    if len(vector) != VECTOR_SIZE:
        raise ValueError(f"Expected vector size {VECTOR_SIZE}, got {len(vector)}")
    return sqlite_vec.serialize_float32(vector)


def _as_catalog(entry: CatalogCourse | dict[str, Any]) -> CatalogCourse | None:
    if isinstance(entry, CatalogCourse):
        course = entry
    else:
        course = CatalogCourse.model_validate(entry)
    code = normalize_code(course.code)
    if not code:
        return None
    return course.model_copy(update={"code": code})


def upsert_catalog_courses(
    courses: list[CatalogCourse] | list[dict[str, Any]],
    conn: sqlite3.Connection | None = None,
) -> int:
    conn, owned = _ensure(conn)
    rows = []
    for entry in courses:
        course = _as_catalog(entry)
        if not course:
            continue
        rows.append(
            (
                course.code,
                empty_str(course.title),
                empty_str(course.description),
                empty_str(course.credits),
                empty_str(course.lecture),
                empty_str(course.lab),
                empty_str(course.prerequisites),
                empty_str(course.corequisites),
                empty_str(course.satisfies),
            )
        )
    conn.executemany(
        """
        INSERT INTO catalog_courses (
            code, title, description, credits, lecture, lab,
            prerequisites, corequisites, satisfies
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            credits = excluded.credits,
            lecture = excluded.lecture,
            lab = excluded.lab,
            prerequisites = excluded.prerequisites,
            corequisites = excluded.corequisites,
            satisfies = excluded.satisfies
        """,
        rows,
    )
    conn.commit()
    if owned:
        conn.close()
    return len(rows)


def upsert_semester(
    season: str,
    year: int,
    term_code: str = "",
    label: str | None = None,
    conn: sqlite3.Connection | None = None,
) -> int:
    conn, owned = _ensure(conn)
    season = season.lower()
    label = label or semester_label(season, year)
    scraped_at = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """
        INSERT INTO semesters (season, year, label, term_code, scraped_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(season, year) DO UPDATE SET
            label = excluded.label,
            term_code = excluded.term_code,
            scraped_at = excluded.scraped_at
        """,
        (season, year, label, term_code, scraped_at),
    )
    row = conn.execute(
        "SELECT id FROM semesters WHERE season = ? AND year = ?",
        (season, year),
    ).fetchone()
    conn.commit()
    semester_id = int(row["id"])
    if owned:
        conn.close()
    return semester_id


def _normalize_sections(sections: dict[str, Any]) -> dict[str, Any]:
    """Accept {label: {bucket: [...]}} or {bucket: [...]}."""
    if not sections:
        return {}
    if all(isinstance(v, dict) for v in sections.values()):
        first = next(iter(sections.values()))
        if first and all(isinstance(v, list) for v in first.values()):
            return first
    return sections


def replace_semester_courses(
    semester_id: int,
    courses: list[Offering] | list[dict[str, Any]],
    conn: sqlite3.Connection | None = None,
) -> int:
    """Replace all offerings for a semester. sections_json is bucket -> [sections]."""
    conn, owned = _ensure(conn)
    conn.execute("DELETE FROM courses WHERE semester_id = ?", (semester_id,))
    rows = []
    for course in courses:
        offering = (
            course
            if isinstance(course, Offering)
            else Offering.model_validate(course)
        )
        name = empty_str(offering.course_name)
        if not name:
            continue
        sections = _normalize_sections(offering.sections or {})
        rows.append(
            (
                semester_id,
                name,
                empty_str(offering.title),
                json.dumps(sections),
            )
        )
    conn.executemany(
        """
        INSERT INTO courses (semester_id, course_name, title, sections_json)
        VALUES (?, ?, ?, ?)
        """,
        rows,
    )
    conn.commit()
    if owned:
        conn.close()
    return len(rows)


def get_semester(
    season: str | None = None,
    year: int | None = None,
    label: str | None = None,
    conn: sqlite3.Connection | None = None,
) -> Semester | None:
    conn, owned = _ensure(conn)
    if label:
        row = conn.execute(
            "SELECT * FROM semesters WHERE label = ?",
            (label,),
        ).fetchone()
    elif season is not None and year is not None:
        row = conn.execute(
            "SELECT * FROM semesters WHERE season = ? AND year = ?",
            (season.lower(), year),
        ).fetchone()
    else:
        row = None
    result = Semester.model_validate(dict(row)) if row else None
    if owned:
        conn.close()
    return result


def list_semesters(conn: sqlite3.Connection | None = None) -> list[Semester]:
    conn, owned = _ensure(conn)
    rows = conn.execute(
        """
        SELECT s.*, COUNT(c.id) AS course_count
        FROM semesters s
        LEFT JOIN courses c ON c.semester_id = s.id
        GROUP BY s.id
        ORDER BY s.year DESC,
            CASE s.season
                WHEN 'fall' THEN 3
                WHEN 'summer' THEN 2
                WHEN 'spring' THEN 1
                ELSE 0
            END DESC
        """
    ).fetchall()
    result = [Semester.model_validate(dict(row)) for row in rows]
    if owned:
        conn.close()
    return result


def _course_from_row(
    row: sqlite3.Row,
    catalog: CatalogCourse | None,
    semester_label_value: str,
) -> PopCourse:
    sections_buckets = json.loads(row["sections_json"] or "{}")
    description = ""
    attributes = ""
    if catalog:
        description = empty_str(catalog.description)
        attributes = catalog_attributes(catalog)
    return PopCourse(
        name=row["course_name"],
        title=row["title"],
        description=description,
        attributes=attributes,
        sections={semester_label_value: sections_buckets},
    )


def load_semester_courses(
    season: str | None = None,
    year: int | None = None,
    label: str | None = None,
    conn: sqlite3.Connection | None = None,
) -> tuple[Semester, list[PopCourse]]:
    """Return (semester, courses) joined with catalog descriptions."""
    conn, owned = _ensure(conn)
    semester = get_semester(season=season, year=year, label=label, conn=conn)
    if not semester:
        if owned:
            conn.close()
        raise LookupError("Semester not found in database")

    course_rows = conn.execute(
        """
        SELECT * FROM courses
        WHERE semester_id = ?
        ORDER BY course_name
        """,
        (semester.id,),
    ).fetchall()

    catalog_rows = conn.execute("SELECT * FROM catalog_courses").fetchall()
    catalog_by_code = {
        row["code"]: CatalogCourse.model_validate(dict(row)) for row in catalog_rows
    }

    courses = []
    for row in course_rows:
        catalog = catalog_by_code.get(normalize_code(row["course_name"]))
        courses.append(_course_from_row(row, catalog, semester.label))

    if owned:
        conn.close()
    return semester, courses


def export_semester_payload(
    season: str,
    year: int,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    semester, courses = load_semester_courses(season=season, year=year, conn=conn)
    return {
        "semester_name": semester.label,
        "term_code": semester.term_code or "",
        "courses": [c.model_dump() for c in courses],
    }


def write_semester_files(
    season: str,
    year: int,
    data_dir: Path | None = None,
    conn: sqlite3.Connection | None = None,
) -> tuple[Path, Path]:
    """Write Pop UI .js / .json sidecars from SQLite."""
    data_dir = data_dir or (ROOT / "www" / "data")
    data_dir.mkdir(parents=True, exist_ok=True)
    payload = export_semester_payload(season, year, conn=conn)
    semester_name = payload["semester_name"]
    term_code = payload.get("term_code") or ""
    courses = payload["courses"]
    base = f"{season.lower()}_{year}"
    js_path = data_dir / f"{base}.js"
    json_path = data_dir / f"{base}.json"
    js_content = (
        f'var semesters = ["{semester_name}"];\n'
        f'var semester_codes = {{"{semester_name}": "{term_code}"}};\n'
        f"var courses = {json.dumps(courses, indent=4)};\n"
    )
    js_path.write_text(js_content, encoding="utf-8")
    json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return js_path, json_path


def catalog_count(conn: sqlite3.Connection | None = None) -> int:
    conn, owned = _ensure(conn)
    row = conn.execute("SELECT COUNT(*) AS n FROM catalog_courses").fetchone()
    count = int(row["n"])
    if owned:
        conn.close()
    return count


def embedding_count(
    semester_id: int | None = None,
    season: str | None = None,
    year: int | None = None,
    label: str | None = None,
    conn: sqlite3.Connection | None = None,
) -> int:
    conn, owned = _ensure(conn)
    if semester_id is None and (label or (season is not None and year is not None)):
        semester = get_semester(season=season, year=year, label=label, conn=conn)
        if not semester:
            if owned:
                conn.close()
            return 0
        semester_id = semester.id
    if semester_id is None:
        row = conn.execute("SELECT COUNT(*) AS n FROM course_embeddings").fetchone()
    else:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM course_embeddings WHERE semester_id = ?",
            (semester_id,),
        ).fetchone()
    count = int(row["n"])
    if owned:
        conn.close()
    return count


def delete_semester_embeddings(
    semester_id: int,
    conn: sqlite3.Connection | None = None,
) -> None:
    conn, owned = _ensure(conn)
    ids = [
        int(row["id"])
        for row in conn.execute(
            "SELECT id FROM course_embeddings WHERE semester_id = ?",
            (semester_id,),
        ).fetchall()
    ]
    if ids:
        placeholders = ",".join("?" * len(ids))
        conn.execute(
            f"DELETE FROM course_embeddings_vec WHERE rowid IN ({placeholders})",
            ids,
        )
        conn.execute(
            "DELETE FROM course_embeddings WHERE semester_id = ?",
            (semester_id,),
        )
    conn.commit()
    if owned:
        conn.close()


def replace_semester_embeddings(
    semester_id: int,
    rows: list[EmbeddingRow] | list[dict[str, Any]],
    conn: sqlite3.Connection | None = None,
) -> int:
    """Replace all embeddings for a semester."""
    conn, owned = _ensure(conn)
    delete_semester_embeddings(semester_id, conn=conn)

    count = 0
    for item in rows:
        row = item if isinstance(item, EmbeddingRow) else EmbeddingRow.model_validate(item)
        course_name = empty_str(row.course_name)
        if not course_name or not row.vector:
            continue
        cur = conn.execute(
            """
            INSERT INTO course_embeddings (
                semester_id, course_name, title, embedding_text
            ) VALUES (?, ?, ?, ?)
            """,
            (
                semester_id,
                course_name,
                empty_str(row.title),
                empty_str(row.embedding_text),
            ),
        )
        row_id = int(cur.lastrowid)
        conn.execute(
            "INSERT INTO course_embeddings_vec(rowid, embedding) VALUES (?, ?)",
            (row_id, serialize_vector(list(row.vector))),
        )
        count += 1
    conn.commit()
    if owned:
        conn.close()
    return count


def semantic_search(
    query_vector: list[float],
    semester: str,
    limit: int = 25,
    conn: sqlite3.Connection | None = None,
) -> list[SemanticHit]:
    """KNN search filtered to a semester label. Returns similarity scores."""
    conn, owned = _ensure(conn)
    limit = max(1, min(int(limit), 100))
    total = conn.execute("SELECT COUNT(*) AS n FROM course_embeddings").fetchone()
    total_n = int(total["n"])
    if total_n == 0:
        if owned:
            conn.close()
        return []

    knn_k = total_n
    query_blob = serialize_vector(list(query_vector))
    rows = conn.execute(
        """
        WITH knn AS (
            SELECT rowid, distance
            FROM course_embeddings_vec
            WHERE embedding MATCH ?
              AND k = ?
        )
        SELECT
            ce.course_name,
            ce.title,
            ce.embedding_text,
            knn.distance
        FROM knn
        JOIN course_embeddings ce ON ce.id = knn.rowid
        JOIN semesters s ON s.id = ce.semester_id
        WHERE s.label = ?
        ORDER BY knn.distance ASC
        LIMIT ?
        """,
        (query_blob, knn_k, semester, limit),
    ).fetchall()

    results = [
        SemanticHit(
            course_name=row["course_name"],
            title=row["title"],
            score=max(0.0, 1.0 - float(row["distance"] or 0.0)),
            embedding_text=row["embedding_text"] or "",
        )
        for row in rows
    ]
    if owned:
        conn.close()
    return results
