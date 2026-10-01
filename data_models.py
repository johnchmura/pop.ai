"""Shared Pydantic domain models for catalog, offerings, and semantic search."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class CatalogCourse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    code: str
    title: str = ""
    description: str = ""
    credits: str = ""
    lecture: str = ""
    lab: str = ""
    prerequisites: str = ""
    corequisites: str = ""
    satisfies: str = ""


class Semester(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    season: str
    year: int
    label: str
    term_code: str = ""
    scraped_at: str = ""
    course_count: int = 0


class Offering(BaseModel):
    """Per-semester offering stored in the courses table (sections only)."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    course_name: str = Field(validation_alias="name")
    title: str = ""
    sections: dict[str, Any] = Field(default_factory=dict)
    semester_id: int | None = None


class PopCourse(BaseModel):
    """Joined course shape used by Pop JS export and embedding text."""

    model_config = ConfigDict(extra="ignore")

    name: str
    title: str = ""
    description: str = ""
    attributes: str = ""
    sections: dict[str, Any] = Field(default_factory=dict)


class SemanticHit(BaseModel):
    model_config = ConfigDict(extra="ignore")

    course_name: str
    title: str = ""
    score: float
    embedding_text: str = ""


class EmbeddingRow(BaseModel):
    model_config = ConfigDict(extra="ignore")

    course_name: str
    title: str = ""
    embedding_text: str = ""
    vector: list[float]
