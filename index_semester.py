#!/usr/bin/env python3
"""Index semester courses into Docker Qdrant."""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

from qdrant_client.http import models

from api import (
    embed_texts,
    ensure_collection,
    get_client,
    point_id,
    upsert_points,
)

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "www" / "data"

SUBJECT_LABELS = {
    "AAH": "Art and Architectural History",
    "ARCH": "Architecture",
    "AS": "Air Force Aerospace Studies",
    "AURB": "Architecture and Urbanism",
    "BANL": "Business Analytics",
    "BIOL": "Biology",
    "BME": "Biomedical Engineering",
    "BRVN": "Braven",
    "BUS": "Business",
    "CAE": "Civil and Architectural Engr",
    "CAPS": "Comm for Acad and Prof Success",
    "CHE": "Chemical Engineering",
    "CHEM": "Chemistry",
    "COM": "Communications",
    "COOP": "Cooperative Education",
    "CS": "Computer Science",
    "CSP": "Computer Science Prof Master",
    "DS": "Data Science",
    "ECE": "Electrical and Computer Engr",
    "ECON": "Economics",
    "EMGT": "Engineering Management",
    "ENGR": "General Engineering",
    "ENVE": "Environmental Engineering",
    "EXCH": "Exchange Student",
    "FDSN": "Food Science and Nutrition",
    "GCS": "Graduate Continuation Studies",
    "GEM": "Game Design & Experiential Mgm",
    "HIST": "History",
    "HUM": "Humanities",
    "ID": "Institute of Design",
    "IDN": "Institute of Design",
    "IDX": "Institute of Design",
    "IEP": "Intensive English Program",
    "INTM": "Industrial Tech and Mgmt",
    "INTR": "Internship",
    "IPRO": "Interprofessional Project",
    "ITM": "Information Tech and Mgmt",
    "ITMD": "ITM Development",
    "ITMM": "ITM Management",
    "ITMO": "ITM Operations",
    "ITMS": "ITM Security",
    "ITMT": "ITM Theory and Technology",
    "LA": "Landscape Architecture",
    "LAW": "Law",
    "LCS": "Law Continuation Studies",
    "LIT": "Literature",
    "MATH": "Mathematics",
    "MAX": "Marketing Analytics",
    "MBA": "MBA Business",
    "MILS": "Military Science",
    "MMAE": "Mechl, Mtrls and Arspc Engrg",
    "MS": "Materials Science",
    "MSC": "Management Science",
    "MSF": "Master of Science in Finance",
    "NS": "Naval Science",
    "PA": "Public Administration",
    "PD": "Professional Development",
    "PHIL": "Philosophy",
    "PHYS": "Physics",
    "PM": "Project Management",
    "PS": "Political Science",
    "PSYC": "Psychology",
    "SAM": "Sustainability Analytics & Ma",
    "SOC": "Sociology",
    "SSB": "Stuart School of Business",
    "SSCI": "Social Sciences",
    "STAT": "Statistics",
    "STDA": "Study Abroad",
    "TASI": "Technology & Social Innovation",
    "TECH": "Technology",
    "UCS": "Undergrad Continuing Studies",
}

_ATTR_PATTERNS = {
    "credits": re.compile(r"Credits:\s*([^\.]+)", re.I),
    "lecture": re.compile(r"Lecture:\s*([^\.]+)", re.I),
    "lab": re.compile(r"Lab:\s*([^\.]+)", re.I),
    "prerequisites": re.compile(r"Prerequisite\(s\):\s*([^\.]+)", re.I),
    "corequisites": re.compile(r"Corequisite\(s\):\s*([^\.]+)", re.I),
    "satisfies": re.compile(r"Satisfies:\s*([^\.]+)", re.I),
}

_TIME_RANGE = re.compile(
    r"(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)",
    re.I,
)


def semester_name(semester: str, year: int) -> str:
    return f"{semester.capitalize()} {year}"


def subject_code(course_name: str) -> str:
    parts = course_name.strip().split()
    return parts[0].upper() if parts else ""


def subject_label(course_name: str) -> str:
    code = subject_code(course_name)
    return SUBJECT_LABELS.get(code, code or "Unknown")


def parse_attributes(attributes: str) -> dict[str, str]:
    text = (attributes or "").strip()
    parsed = {}
    for key, pattern in _ATTR_PATTERNS.items():
        match = pattern.search(text)
        parsed[key] = match.group(1).strip() if match else ""
    return parsed


def description_missing(course: dict[str, Any]) -> bool:
    return not (course.get("description") or "").strip()


def _none_if_empty(value: str) -> str:
    text = (value or "").strip()
    return text if text else "None"


def _iter_sections(course: dict[str, Any]):
    for semester_sections in (course.get("sections") or {}).values():
        for bucket, bucket_sections in semester_sections.items():
            for section in bucket_sections:
                yield bucket, section


def build_embedding_text(course: dict[str, Any]) -> str:
    name = course.get("name", "")
    title = course.get("title", "")
    description = (course.get("description") or "").strip()
    attrs = parse_attributes(course.get("attributes") or "")

    special_titles = sorted({
        (section.get("special_title") or "").strip()
        for _, section in _iter_sections(course)
        if (section.get("special_title") or "").strip()
    })
    schedule_types = sorted({
        (section.get("schedule_type") or "").strip()
        for _, section in _iter_sections(course)
        if (section.get("schedule_type") or "").strip()
    })
    delivery = sorted({
        bucket
        for semester_sections in (course.get("sections") or {}).values()
        for bucket in semester_sections.keys()
    })

    return "\n".join([
        f"Course: {name} — {title}",
        f"Subject: {subject_label(name)}",
        (
            f"Credits: {attrs.get('credits') or 'Unknown'}. "
            f"Lecture: {attrs.get('lecture') or 'Unknown'}. "
            f"Lab: {attrs.get('lab') or 'Unknown'}."
        ),
        f"Description: {description or 'None'}",
        f"Prerequisites: {_none_if_empty(attrs.get('prerequisites', ''))}",
        f"Corequisites: {_none_if_empty(attrs.get('corequisites', ''))}",
        f"Satisfies: {_none_if_empty(attrs.get('satisfies', ''))}",
        f"Section topics: {', '.join(special_titles) if special_titles else 'None'}",
        f"Formats offered: {', '.join(schedule_types) if schedule_types else 'None'}",
        f"Delivery: {', '.join(delivery) if delivery else 'None'}",
    ])


def _to_minutes(hour: int, minute: int, period: str) -> int:
    period = period.upper()
    if period == "AM":
        if hour == 12:
            hour = 0
    elif hour != 12:
        hour += 12
    return hour * 60 + minute


def parse_time_range(time_str: str) -> dict[str, int] | None:
    text = (time_str or "").strip()
    if not text or text.upper() == "TBA":
        return None
    match = _TIME_RANGE.search(text)
    if not match:
        return None
    return {
        "start_min": _to_minutes(int(match.group(1)), int(match.group(2) or 0), match.group(3)),
        "end_min": _to_minutes(int(match.group(4)), int(match.group(5) or 0), match.group(6)),
    }


def _available_count(value: Any) -> int:
    if value is None or value == "":
        return 0
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def build_payload(course: dict[str, Any], semester: str) -> dict[str, Any]:
    instructors: set[str] = set()
    days: set[str] = set()
    campuses: set[str] = set()
    delivery: set[str] = set()
    crns: list[str] = []
    time_ranges: list[dict[str, int]] = []
    has_open_sections = False

    attrs = parse_attributes(course.get("attributes") or "")
    credits_raw = attrs.get("credits", "")
    try:
        credits = int(credits_raw) if credits_raw else None
    except ValueError:
        credits = None

    for bucket, section in _iter_sections(course):
        delivery.add(bucket)
        crn = str(section.get("crn") or "").strip()
        if crn:
            crns.append(crn)
        if _available_count(section.get("available")) > 0:
            has_open_sections = True
        campus = str(section.get("campus") or "").strip()
        if campus:
            campuses.add(campus)
        for meeting in section.get("meetings") or []:
            meeting_days = str(meeting.get("days") or "").strip()
            if meeting_days and meeting_days.upper() != "TBA":
                days.add(meeting_days)
            parsed = parse_time_range(meeting.get("time") or "")
            if parsed:
                time_ranges.append(parsed)
            for instructor in meeting.get("instructors") or []:
                name = str(instructor).strip()
                if name:
                    instructors.add(name)

    unique_ranges = []
    seen = set()
    for item in time_ranges:
        key = (item["start_min"], item["end_min"])
        if key not in seen:
            seen.add(key)
            unique_ranges.append(item)

    return {
        "semester": semester,
        "course_name": course.get("name", ""),
        "title": course.get("title", ""),
        "subject_code": subject_code(course.get("name", "")),
        "credits": credits,
        "has_open_sections": has_open_sections,
        "instructors": sorted(instructors),
        "days": sorted(days),
        "time_ranges": unique_ranges,
        "campuses": sorted(campuses),
        "delivery": sorted(delivery),
        "crns": crns,
        "description_missing": description_missing(course),
    }


def _parse_js_file(path: Path) -> dict:
    content = path.read_text(encoding="utf-8")
    semesters_match = re.search(r"var semesters = (\[[^\]]*\]);", content)
    courses_match = re.search(r"var courses = (\[.*\]);?\s*$", content, re.S)
    if not courses_match:
        raise ValueError(f"Could not parse courses from {path}")
    semesters = json.loads(semesters_match.group(1)) if semesters_match else []
    courses = json.loads(courses_match.group(1))
    return {"semester_name": semesters[0] if semesters else "", "courses": courses}


def load_semester_data(semester: str, year: int) -> tuple[str, list[dict]]:
    json_path = DATA_DIR / f"{semester.lower()}_{year}.json"
    js_path = DATA_DIR / f"{semester.lower()}_{year}.js"
    if json_path.exists():
        with open(json_path, encoding="utf-8") as handle:
            payload = json.load(handle)
    elif js_path.exists():
        payload = _parse_js_file(js_path)
    else:
        raise FileNotFoundError(
            f"Missing semester data at {json_path} or {js_path}. "
            "Run scraping/scrape_courses.py first."
        )
    name = payload.get("semester_name") or semester_name(semester, year)
    return name, payload.get("courses") or []


def build_points(semester: str, courses: list[dict]) -> list[models.PointStruct]:
    texts = [build_embedding_text(course) for course in courses]
    vectors = embed_texts(texts)
    points = []
    for course, vector in zip(courses, vectors):
        course_name = course.get("name", "")
        if not course_name:
            continue
        points.append(
            models.PointStruct(
                id=point_id(semester, course_name),
                vector=vector,
                payload=build_payload(course, semester),
            )
        )
    return points


def main() -> None:
    parser = argparse.ArgumentParser(description="Index semester courses into Qdrant.")
    parser.add_argument("semester", choices=["spring", "summer", "fall"], type=str.lower)
    parser.add_argument("year", type=int)
    parser.add_argument("--batch-size", type=int, default=64)
    args = parser.parse_args()

    semester_label, courses = load_semester_data(args.semester, args.year)
    if not courses:
        print(f"No courses found for {semester_label}")
        sys.exit(1)

    print(f"Embedding {len(courses)} courses for {semester_label}...")
    points = build_points(semester_label, courses)
    client = get_client()
    ensure_collection(client)

    for start in range(0, len(points), args.batch_size):
        batch = points[start : start + args.batch_size]
        upsert_points(batch, client)
        print(f"Upserted {min(start + len(batch), len(points))}/{len(points)}")

    print(f"Indexed {len(points)} courses for {semester_label}.")


if __name__ == "__main__":
    main()
