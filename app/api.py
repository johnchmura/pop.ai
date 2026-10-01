"""Pop.ai semantic search API (SQLite + sqlite-vec + local embeddings)."""

from __future__ import annotations

import os
import sys
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

from app.data_models import EmbeddingRow, PopCourse, SemanticHit
from app.db import (
    catalog_count,
    embedding_count,
    get_semester,
    init_db,
    load_semester_courses,
    replace_semester_embeddings,
    semantic_search,
)

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")


@lru_cache(maxsize=1)
def _model() -> SentenceTransformer:
    return SentenceTransformer(EMBEDDING_MODEL)


def embed_texts(texts: list[str], batch_size: int = 32) -> list[list[float]]:
    if not texts:
        return []
    vectors = _model().encode(
        texts,
        batch_size=batch_size,
        normalize_embeddings=True,
        show_progress_bar=len(texts) > 50,
    )
    return vectors.tolist()


def embed_query(query: str) -> list[float]:
    return embed_texts([query])[0]


def subject_code(course_name: str) -> str:
    parts = course_name.strip().split()
    return parts[0].upper() if parts else ""


def _iter_sections(course: PopCourse):
    for semester_sections in (course.sections or {}).values():
        if not isinstance(semester_sections, dict):
            continue
        for bucket, bucket_sections in semester_sections.items():
            for section in bucket_sections or []:
                yield bucket, section


def build_embedding_text(course: PopCourse) -> str:
    name = course.name
    title = course.title
    description = (course.description or "").strip() or "None"
    attributes = (course.attributes or "").strip() or "None"

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
        for semester_sections in (course.sections or {}).values()
        if isinstance(semester_sections, dict)
        for bucket in semester_sections.keys()
    })

    return "\n".join([
        f"Course: {name} — {title}",
        f"Subject: {subject_code(name) or 'Unknown'}",
        f"Attributes: {attributes}",
        f"Description: {description}",
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


def index_semester(season: str, year: int) -> int:
    """Embed and upsert all courses for a semester. Returns count indexed."""
    season = season.lower()
    semester = get_semester(season=season, year=year)
    if not semester:
        print(
            f"Semester {season} {year} not found in SQLite. "
            "Run scraping/scrape_courses.py first."
        )
        sys.exit(1)

    _, courses = load_semester_courses(season=season, year=year)
    if not courses:
        print(f"No courses found for {semester.label}")
        sys.exit(1)

    print(f"Embedding {len(courses)} courses for {semester.label}...")
    rows = build_embedding_rows(courses)
    count = replace_semester_embeddings(semester.id, rows)
    print(f"Indexed {count} courses for {semester.label} into SQLite.")
    return count


app = FastAPI(title="Pop.ai Semantic Search", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000", "http://127.0.0.1:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SemanticSearchRequest(BaseModel):
    query: str = Field(min_length=1)
    semester: str = Field(min_length=1)
    limit: int = Field(default=25, ge=1, le=100)


class SemanticSearchResponse(BaseModel):
    results: list[SemanticHit]


@app.on_event("startup")
def _startup() -> None:
    init_db()


@app.get("/health")
def health() -> dict:
    try:
        init_db()
        return {
            "status": "ok",
            "catalog_count": catalog_count(),
            "embedding_count": embedding_count(),
        }
    except Exception as exc:
        return {
            "status": "degraded",
            "error": str(exc),
            "catalog_count": 0,
            "embedding_count": 0,
        }


@app.post("/search/semantic", response_model=SemanticSearchResponse)
def search_semantic(body: SemanticSearchRequest) -> SemanticSearchResponse:
    vector = embed_query(body.query.strip())
    hits = semantic_search(vector, body.semester.strip(), body.limit)
    return SemanticSearchResponse(results=hits)
