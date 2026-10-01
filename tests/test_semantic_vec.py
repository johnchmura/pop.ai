"""sqlite-vec semantic search tests (fixed vectors; no model download)."""

from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from data_models import EmbeddingRow, SemanticHit
from db import (
    VECTOR_SIZE,
    connect,
    embedding_count,
    embedding_status,
    init_db,
    replace_semester_embeddings,
    semantic_search,
    upsert_semester,
)
from index_semester import build_embedding_text


def unit_vector(index: int, size: int = VECTOR_SIZE) -> list[float]:
    vec = [0.0] * size
    vec[index % size] = 1.0
    return vec


def near_vector(index: int, noise: float = 0.05, size: int = VECTOR_SIZE) -> list[float]:
    vec = [noise / size] * size
    vec[index % size] = 1.0
    norm = math.sqrt(sum(x * x for x in vec))
    return [x / norm for x in vec]


class SemanticVecTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmpdir.name) / "test.db"
        self.conn = init_db(connect(self.db_path))
        self.fall_id = upsert_semester(
            "fall", 2026, label="Fall 2026", conn=self.conn
        )
        self.spring_id = upsert_semester(
            "spring", 2026, label="Spring 2026", conn=self.conn
        )

    def tearDown(self):
        self.conn.close()
        self._tmpdir.cleanup()

    def _seed_embeddings(self):
        replace_semester_embeddings(
            self.fall_id,
            [
                EmbeddingRow(
                    course_name="CS 430",
                    title="Introduction to Algorithms",
                    embedding_text="Course: CS 430 — algorithms graph theory",
                    vector=unit_vector(0),
                ),
                EmbeddingRow(
                    course_name="ART 100",
                    title="Introduction to Drawing",
                    embedding_text="Course: ART 100 — drawing studio",
                    vector=unit_vector(1),
                ),
            ],
            conn=self.conn,
        )
        replace_semester_embeddings(
            self.spring_id,
            [
                EmbeddingRow(
                    course_name="CS 430",
                    title="Introduction to Algorithms",
                    embedding_text="Course: CS 430 — spring offering",
                    vector=unit_vector(0),
                )
            ],
            conn=self.conn,
        )

    def test_knn_ranking_and_embedding_text(self):
        self._seed_embeddings()
        hits = semantic_search(near_vector(0), "Fall 2026", limit=5, conn=self.conn)
        self.assertGreaterEqual(len(hits), 1)
        self.assertIsInstance(hits[0], SemanticHit)
        self.assertEqual(hits[0].course_name, "CS 430")
        self.assertIn("algorithms", hits[0].embedding_text)
        self.assertGreater(hits[0].score, 0.9)

        art_hits = semantic_search(near_vector(1), "Fall 2026", limit=5, conn=self.conn)
        self.assertEqual(art_hits[0].course_name, "ART 100")

    def test_semester_filter(self):
        self._seed_embeddings()
        hits = semantic_search(near_vector(1), "Spring 2026", limit=10, conn=self.conn)
        names = [h.course_name for h in hits]
        self.assertNotIn("ART 100", names)
        self.assertIn("CS 430", names)
        self.assertIn("spring offering", hits[0].embedding_text)

    def test_reindex_replaces_rows(self):
        self._seed_embeddings()
        self.assertEqual(embedding_count(semester_id=self.fall_id, conn=self.conn), 2)
        replace_semester_embeddings(
            self.fall_id,
            [
                EmbeddingRow(
                    course_name="CS 331",
                    title="Data Structures",
                    embedding_text="Course: CS 331 — trees heaps",
                    vector=unit_vector(2),
                )
            ],
            conn=self.conn,
        )
        self.assertEqual(embedding_count(semester_id=self.fall_id, conn=self.conn), 1)
        hits = semantic_search(near_vector(2), "Fall 2026", limit=5, conn=self.conn)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0].course_name, "CS 331")

    def test_embedding_status(self):
        self._seed_embeddings()
        status = embedding_status(conn=self.conn)
        self.assertEqual(status["embedding_count"], 3)
        self.assertIn("Fall 2026", status["indexed_semesters"])
        self.assertEqual(status["counts_by_semester"]["Fall 2026"], 2)

    def test_api_search_returns_embedding_text(self):
        sample = [
            SemanticHit(
                course_name="CS 430",
                title="Introduction to Algorithms",
                score=0.95,
                embedding_text="Course: CS 430 — algorithms graph theory",
            )
        ]
        with patch("api.embed_query", return_value=near_vector(0)):
            with patch("api.semantic_search", return_value=sample):
                with patch("api.init_db"):
                    import api

                    client = TestClient(api.app)
                    response = client.post(
                        "/search/semantic",
                        json={
                            "query": "graph algorithms",
                            "semester": "Fall 2026",
                            "limit": 5,
                        },
                    )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(len(body["results"]), 1)
        top = body["results"][0]
        self.assertEqual(top["course_name"], "CS 430")
        self.assertIn("algorithms", top["embedding_text"])
        self.assertNotIn("meta", top)


class IndexerFailClosedTests(unittest.TestCase):
    def test_index_requires_sqlite_semester(self):
        import index_semester

        with patch("index_semester.get_semester", return_value=None):
            with patch("sys.argv", ["index_semester.py", "fall", "2099"]):
                with self.assertRaises(SystemExit) as ctx:
                    index_semester.main()
                self.assertEqual(ctx.exception.code, 1)


class EmbeddingTextTests(unittest.TestCase):
    def test_build_embedding_text_from_dict(self):
        text = build_embedding_text(
            {
                "name": "CS 430",
                "title": "Introduction to Algorithms",
                "description": "Analysis of algorithms and data structures.",
                "attributes": (
                    "Credits: 3. Lecture: 3. Lab: 0. "
                    "Prerequisite(s): CS 331. "
                    "Corequisite(s): None. "
                    "Satisfies: None."
                ),
                "sections": {
                    "Fall 2026": {
                        "Class": [
                            {
                                "crn": "12345",
                                "schedule_type": "Lecture",
                                "special_title": "Advanced Topics",
                                "meetings": [],
                            }
                        ]
                    }
                },
            }
        )
        self.assertIn("Course: CS 430 — Introduction to Algorithms", text)
        self.assertIn("Subject: Computer Science", text)
        self.assertIn("Description: Analysis of algorithms", text)
        self.assertIn("Prerequisites: CS 331", text)
        self.assertIn("Section topics: Advanced Topics", text)


if __name__ == "__main__":
    unittest.main()
