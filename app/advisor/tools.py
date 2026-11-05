"""Course lookups the chat model can call. Results stay small and only include this semester."""

from __future__ import annotations

import json
from typing import Any

from app.advisor.catalog import course_row_json, normalize_code

SEARCH_LIMIT = 12
DETAIL_LIMIT = 8

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "search_courses",
            "description": "Filter courses that have sections this semester. min_level and max_level use the hundreds digit: 400 means 400-499.",
            "parameters": {
                "type": "object",
                "properties": {
                    "subject": {"type": "string", "description": "Department code, such as ECE or CS."},
                    "min_level": {"type": "integer", "description": "Lowest level. 300 means 300-level and above."},
                    "max_level": {"type": "integer", "description": "Highest level. 400 means up through 400-level."},
                    "words": {"type": "string", "description": "Words that must each appear in the code, title, or description."},
                    "limit": {"type": "integer", "description": "How many courses to return, at most 12."},
                },
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_courses_semantic",
            "description": "Find courses offered this semester by topic, using meaning rather than exact words.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What the student is looking for, in ordinary words."},
                    "limit": {"type": "integer", "description": "How many courses to return, at most 12."},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "course_details",
            "description": "Full catalog row, prerequisites, and sections for courses you will mention. Only courses offered this semester.",
            "parameters": {
                "type": "object",
                "properties": {
                    "codes": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Course codes, such as ECE 429. At most 8.",
                    },
                },
                "required": ["codes"],
                "additionalProperties": False,
            },
        },
    },
]


def tool_note(semester: str) -> str:
    term = semester or "this semester"
    return (
        f"LOOKUPS: You can search the {term} schedule with tools. "
        "search_courses filters offered courses by department, level, and words in the code, title, or description. "
        "search_courses_semantic finds offered courses by topic. "
        "course_details returns prerequisites and sections for codes you will mention. "
        "Call a search before saying a course is missing. Cite only courses the tools returned. "
        "Do not invent codes, titles, prerequisites, times, or instructors."
    )


def _js(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _parse_args(arguments: Any) -> dict:
    if isinstance(arguments, dict):
        return arguments
    if not isinstance(arguments, str) or not arguments.strip():
        return {}
    try:
        parsed = json.loads(arguments)
    except ValueError as exc:
        raise ValueError("Arguments must be a JSON object.") from exc
    if not isinstance(parsed, dict):
        raise ValueError("Arguments must be a JSON object.")
    return parsed


def _level_bucket(value: Any, name: str) -> int | None:
    if value is None or value == "":
        return None
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer.") from exc
    if number < 0 or number > 900:
        raise ValueError(f"{name} must be between 0 and 900.")
    if number < 10:
        return number * 100
    return (number // 100) * 100


def _limit(value: Any, cap: int) -> int:
    if value is None or value == "":
        return cap
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("limit must be an integer.") from exc
    return max(1, min(number, cap))


def _words(value: Any) -> list[str]:
    if isinstance(value, list):
        value = " ".join(str(part) for part in value)
    return [word.lower() for word in str(value or "").split() if word.strip()]


def _offered(course: dict) -> bool:
    return bool(course.get("sections"))


def _short(course: dict) -> dict[str, Any]:
    description = str(course.get("description") or "").strip()
    if len(description) > 160:
        description = description[:157].rstrip() + "..."
    return {
        "code": course["code"],
        "title": course.get("title") or "",
        "credits": course.get("credits") or "",
        "level": course.get("level") or 0,
        "description": description,
    }


def _matches_words(course: dict, words: list[str]) -> bool:
    haystack = f"{course.get('code') or ''} {course.get('title') or ''} {course.get('description') or ''}".lower()
    return all(word in haystack for word in words)


def search_courses(index: dict, args: dict) -> str:
    subject = str(args.get("subject") or "").strip().upper()
    words = _words(args.get("words"))
    min_level = _level_bucket(args.get("min_level"), "min_level")
    max_level = _level_bucket(args.get("max_level"), "max_level")
    if min_level is not None and max_level is not None and min_level > max_level:
        return "min_level is above max_level."
    if not subject and not words and min_level is None and max_level is None:
        return "Give a subject, a level range, or words to search for."
    limit = _limit(args.get("limit"), SEARCH_LIMIT)
    found: list[dict[str, Any]] = []
    for course in index.get("list") or []:
        if not _offered(course):
            continue
        if subject and str(course.get("subject") or "").upper() != subject:
            continue
        level = int(course.get("level") or 0)
        if min_level is not None and level < min_level:
            continue
        if max_level is not None and level > max_level:
            continue
        if words and not _matches_words(course, words):
            continue
        found.append(_short(course))
        if len(found) >= limit:
            break
    return _js({"semester": index.get("semester") or "", "courses": found})


async def search_courses_semantic(index: dict, args: dict) -> str:
    query = str(args.get("query") or "").strip()
    if not query:
        return "Give a topic to search for."
    limit = _limit(args.get("limit"), SEARCH_LIMIT)
    try:
        import asyncio

        from app.api import embed_query
        from app.db import semantic_search

        vector = await asyncio.to_thread(embed_query, query[:300])
        hits = await asyncio.to_thread(semantic_search, vector, index.get("semester") or "", max(limit * 2, limit))
    except Exception:  # noqa: BLE001 - missing model or embeddings
        return "Semantic search is not available. Use search_courses."
    courses = index.get("courses") or {}
    found: list[dict[str, Any]] = []
    for hit in hits:
        course = courses.get(normalize_code(hit.course_name))
        if not course or not _offered(course):
            continue
        found.append(_short(course))
        if len(found) >= limit:
            break
    return _js({"semester": index.get("semester") or "", "courses": found})


def course_details(index: dict, args: dict) -> str:
    raw = args.get("codes")
    if isinstance(raw, str):
        raw = [part.strip() for part in raw.split(",")]
    if not isinstance(raw, list) or not raw:
        return "Give one or more course codes."
    semester = index.get("semester") or "this semester"
    courses = index.get("courses") or {}
    rows: list[dict[str, Any]] = []
    notes: list[str] = []
    seen: set[str] = set()
    for item in raw[:DETAIL_LIMIT]:
        code = normalize_code(item)
        if not code or code in seen:
            continue
        seen.add(code)
        course = courses.get(code)
        if not course:
            notes.append(f"Unknown code: {code}.")
        elif not _offered(course):
            notes.append(f"Not offered in {semester}: {code}.")
        else:
            rows.append(json.loads(course_row_json(course)))
    if len(raw) > DETAIL_LIMIT:
        notes.append(f"Only the first {DETAIL_LIMIT} codes were looked up.")
    return _js({"semester": semester, "courses": rows, "notes": notes})


async def run_tool(name: str, arguments: Any, index: dict) -> str:
    """Run one tool. Bad arguments come back as text the model can correct."""
    try:
        args = _parse_args(arguments)
        if name == "search_courses":
            return search_courses(index, args)
        if name == "search_courses_semantic":
            return await search_courses_semantic(index, args)
        if name == "course_details":
            return course_details(index, args)
    except ValueError as exc:
        return str(exc)
    except Exception:  # noqa: BLE001
        return "That lookup failed. Try a simpler search."
    return "Unknown tool. Use search_courses, search_courses_semantic, or course_details."
