"""Pop.ai semantic search API (Docker Qdrant + local embeddings)."""

import os
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from qdrant_client import QdrantClient
from qdrant_client.http import models
from sentence_transformers import SentenceTransformer

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")
COLLECTION_NAME = os.getenv("QDRANT_COLLECTION", "pop_courses")
VECTOR_SIZE = 384

PAYLOAD_INDEX_FIELDS = [
    ("semester", models.PayloadSchemaType.KEYWORD),
    ("instructors", models.PayloadSchemaType.KEYWORD),
    ("days", models.PayloadSchemaType.KEYWORD),
    ("campuses", models.PayloadSchemaType.KEYWORD),
    ("has_open_sections", models.PayloadSchemaType.BOOL),
]


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


def get_client() -> QdrantClient:
    return QdrantClient(url=QDRANT_URL)


def point_id(semester: str, course_name: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{semester}:{course_name}"))


def ensure_collection(client: QdrantClient | None = None) -> None:
    client = client or get_client()
    names = {c.name for c in client.get_collections().collections}
    if COLLECTION_NAME not in names:
        client.create_collection(
            collection_name=COLLECTION_NAME,
            vectors_config=models.VectorParams(
                size=VECTOR_SIZE,
                distance=models.Distance.COSINE,
            ),
        )
    for field_name, field_type in PAYLOAD_INDEX_FIELDS:
        try:
            client.create_payload_index(
                collection_name=COLLECTION_NAME,
                field_name=field_name,
                field_schema=field_type,
            )
        except Exception:
            pass


def upsert_points(
    points: list[models.PointStruct],
    client: QdrantClient | None = None,
) -> None:
    client = client or get_client()
    ensure_collection(client)
    client.upsert(collection_name=COLLECTION_NAME, points=points)


def semantic_search(
    query_vector: list[float],
    semester: str,
    limit: int = 25,
    client: QdrantClient | None = None,
) -> list[dict[str, Any]]:
    client = client or get_client()
    ensure_collection(client)
    response = client.query_points(
        collection_name=COLLECTION_NAME,
        query=query_vector,
        query_filter=models.Filter(
            must=[
                models.FieldCondition(
                    key="semester",
                    match=models.MatchValue(value=semester),
                )
            ]
        ),
        limit=limit,
        with_payload=True,
    )
    results = []
    for point in response.points:
        payload = point.payload or {}
        results.append(
            {
                "course_name": payload.get("course_name", ""),
                "title": payload.get("title", ""),
                "score": float(point.score or 0.0),
            }
        )
    return results


def collection_info(client: QdrantClient | None = None) -> dict[str, Any]:
    client = client or get_client()
    ensure_collection(client)
    info = client.get_collection(COLLECTION_NAME)
    semesters: set[str] = set()
    offset = None
    while True:
        records, offset = client.scroll(
            collection_name=COLLECTION_NAME,
            limit=256,
            offset=offset,
            with_vectors=False,
            with_payload=True,
        )
        for record in records:
            semester = (record.payload or {}).get("semester")
            if semester:
                semesters.add(semester)
        if offset is None:
            break
    return {
        "collection": COLLECTION_NAME,
        "points_count": info.points_count,
        "indexed_semesters": sorted(semesters),
    }


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


class SemanticSearchResult(BaseModel):
    course_name: str
    title: str
    score: float


class SemanticSearchResponse(BaseModel):
    results: list[SemanticSearchResult]


@app.get("/health")
def health() -> dict:
    try:
        get_client().get_collections()
        return {"status": "ok", "qdrant_ok": True, "qdrant_error": ""}
    except Exception as exc:
        return {"status": "degraded", "qdrant_ok": False, "qdrant_error": str(exc)}


@app.get("/search/status")
def search_status() -> dict:
    return collection_info()


@app.post("/search/semantic", response_model=SemanticSearchResponse)
def search_semantic(body: SemanticSearchRequest) -> SemanticSearchResponse:
    vector = embed_query(body.query.strip())
    hits = semantic_search(vector, body.semester.strip(), body.limit)
    return SemanticSearchResponse(results=hits)
