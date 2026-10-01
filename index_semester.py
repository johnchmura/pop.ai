#!/usr/bin/env python3
"""Index semester courses into SQLite (sqlite-vec)."""

import argparse
import re
import sys
from typing import Any

from api import embed_texts
from data_models import EmbeddingRow, PopCourse
from db import get_semester, load_semester_courses, replace_semester_embeddings

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


def _none_if_empty(value: str) -> str:
    text = (value or "").strip()
    return text if text else "None"


def _iter_sections(course: PopCourse | dict[str, Any]):
    sections = (
        course.sections if isinstance(course, PopCourse) else (course.get("sections") or {})
    )
    for semester_sections in sections.values():
        if not isinstance(semester_sections, dict):
            continue
        for bucket, bucket_sections in semester_sections.items():
            for section in bucket_sections or []:
                yield bucket, section


def build_embedding_text(course: PopCourse | dict[str, Any]) -> str:
    if isinstance(course, PopCourse):
        name = course.name
        title = course.title
        description = (course.description or "").strip()
        attrs = parse_attributes(course.attributes or "")
        sections = course.sections or {}
    else:
        name = course.get("name", "")
        title = course.get("title", "")
        description = (course.get("description") or "").strip()
        attrs = parse_attributes(course.get("attributes") or "")
        sections = course.get("sections") or {}

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
        for semester_sections in sections.values()
        if isinstance(semester_sections, dict)
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


def build_embedding_rows(courses: list[PopCourse]) -> list[EmbeddingRow]:
    texts = [build_embedding_text(course) for course in courses]
    vectors = embed_texts(texts)
    rows = []
    for course, text, vector in zip(courses, texts, vectors):
        if not course.name:
            continue
        rows.append(
            EmbeddingRow(
                course_name=course.name,
                title=course.title,
                embedding_text=text,
                vector=vector,
            )
        )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Index semester courses into SQLite.")
    parser.add_argument("semester", choices=["spring", "summer", "fall"], type=str.lower)
    parser.add_argument("year", type=int)
    args = parser.parse_args()

    semester = get_semester(season=args.semester, year=args.year)
    if not semester:
        print(
            f"Semester {args.semester} {args.year} not found in SQLite. "
            "Run scraping/scrape_courses.py first."
        )
        sys.exit(1)

    _, courses = load_semester_courses(season=args.semester, year=args.year)
    if not courses:
        print(f"No courses found for {semester.label}")
        sys.exit(1)

    print(f"Embedding {len(courses)} courses for {semester.label}...")
    rows = build_embedding_rows(courses)
    count = replace_semester_embeddings(semester.id, rows)
    print(f"Indexed {count} courses for {semester.label} into SQLite.")


if __name__ == "__main__":
    main()
