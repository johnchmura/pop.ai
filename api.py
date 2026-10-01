"""Pop.ai semantic search API (SQLite + sqlite-vec + local embeddings)."""

import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

from data_models import SemanticHit
from db import (
    VECTOR_SIZE,
    catalog_count,
    embedding_status,
    init_db,
    list_semesters,
    semantic_search,
)

ROOT = Path(__file__).resolve().parent
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
        status = embedding_status()
        return {
            "status": "ok",
            "db_ok": True,
            "db_error": "",
            "vec_ok": True,
            "vec_error": "",
            "catalog_count": catalog_count(),
            "semester_count": len(list_semesters()),
            "embedding_count": status["embedding_count"],
            "vector_size": VECTOR_SIZE,
        }
    except Exception as exc:
        return {
            "status": "degraded",
            "db_ok": False,
            "db_error": str(exc),
            "vec_ok": False,
            "vec_error": str(exc),
            "catalog_count": 0,
            "semester_count": 0,
            "embedding_count": 0,
            "vector_size": VECTOR_SIZE,
        }


@app.post("/search/semantic", response_model=SemanticSearchResponse)
def search_semantic(body: SemanticSearchRequest) -> SemanticSearchResponse:
    vector = embed_query(body.query.strip())
    hits = semantic_search(vector, body.semester.strip(), body.limit)
    return SemanticSearchResponse(results=hits)
