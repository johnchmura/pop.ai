"""advisor. web server, built on Pop.

    uvicorn app.advisor.server:app --port 3000      (or: python main.py advisor-serve)

Pop's SQLite database (data/pop.db) is the source for courses, sections, and degree data.
The page in web/ does the advisor logic (search, schedule, graph, degree audit, plans).
This server:
  GET  /                    the page (web/)
  GET  /data/*.json         catalog, sections, forecast, programs, built from the database
  GET  /api/health          what is loaded, and whether Claude is on
  POST /api/chat            streams Claude's answer (server-sent events)
  POST /api/plan            asks Claude for a semester plan (the page checks it)
  POST /api/transcript      reads a scanned transcript with Claude
  POST /api/search/semantic Pop's meaning-based search, when its model is installed
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
from collections import OrderedDict, defaultdict
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from app.advisor.catalog import (
    build_index,
    catalog_json,
    course_data_text,
    forecast_json,
    programs_json,
    sections_json,
)
from app.advisor.claude import ClaudeError, call_claude, stream_claude
from app.advisor.faculty import FacultyIndex, faculty_block
from app.advisor.store import open_db, seed, is_seeded, get_value
from app.db import ROOT

load_dotenv(ROOT / ".env")

WEB = (ROOT / "web").resolve()


def _int_env(name: str, default: int, low: int, high: int) -> int:
    try:
        return max(low, min(high, int(os.getenv(name, default))))
    except ValueError:
        return default


class Config:
    def __init__(self) -> None:
        self.api_key = (os.getenv("ANTHROPIC_API_KEY") or "").strip()
        self.model = os.getenv("ANTHROPIC_MODEL") or "claude-sonnet-5-5"
        self.base_url = os.getenv("ANTHROPIC_BASE_URL") or "https://api.anthropic.com"
        self.max_tokens = _int_env("MAX_TOKENS", 4096, 128, 8192)
        self.rate_limit = _int_env("CHAT_RATE_LIMIT", 30, 1, 10_000)  # requests per IP per 5 minutes
        self.instructions_file = Path(os.getenv("ADVISOR_INSTRUCTIONS") or ROOT / "advisor_instructions.txt")


config = Config()

# ---------------------------------------------------------------- data (loaded once at start)


class Data:
    """JSON files and COURSE DATA, built from the database. Restart the server after Pop scrapes again."""

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.faculty: FacultyIndex | None = None
        self.faculty_read_on = ""
        self.course_data = ""
        self.health: dict[str, Any] = {}

    def load(self) -> None:
        conn = open_db()
        try:
            if not is_seeded(conn):
                # first start: load seed/ (keeps any catalog or sections Pop already scraped)
                has_catalog = conn.execute("SELECT COUNT(*) FROM catalog_courses").fetchone()[0] > 0
                has_semester = conn.execute("SELECT COUNT(*) FROM semesters").fetchone()[0] > 0
                seed(conn, catalog=not has_catalog, sections=not has_semester)
            catalog = catalog_json(conn)
            sections = sections_json(conn)
            forecast = forecast_json(conn)
            programs = programs_json(conn)
            faculty = get_value(conn, "faculty", [])
            if not faculty and (ROOT / "seed" / "faculty.json").exists():
                from app.advisor.store import import_faculty

                import_faculty(conn, json.loads((ROOT / "seed" / "faculty.json").read_text(encoding="utf-8")))
                faculty = get_value(conn, "faculty", [])
            self.faculty_read_on = get_value(conn, "faculty_read_on", "")
        finally:
            conn.close()
        self.faculty = FacultyIndex(faculty) if faculty else None
        index = build_index(catalog, sections, forecast)
        self.course_data = course_data_text(index, programs["programs"])
        if len(self.course_data) > 700_000:
            print(f"Warning: COURSE DATA is {len(self.course_data):,} characters. Claude may reject requests this long; "
                  "see README (a full catalog scrape adds long descriptions).")
        dump = lambda obj: json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")  # noqa: E731
        self.files = {
            "catalog.json": dump(catalog),
            "sections.json": dump(sections),
            "forecast.json": dump(forecast),
            "programs.json": dump(programs),
        }
        self.health = {
            "semester": index["semester"],
            "sampleSections": index["sample"],
            "courses": len(index["courses"]),
            "sections": len(index["crnMap"]),
            "forecastTerms": [t["label"] for t in (forecast or {}).get("terms", [])],
            "programs": [p["id"] for p in programs["programs"]],
            "faculty": len(self.faculty.records) if self.faculty else 0,
        }


data = Data()

_instructions = {"mtime": 0.0, "text": ""}


def instructions() -> str:
    """The advisor's system prompt. Re-read when the file changes, so edits apply without a restart."""
    mtime = config.instructions_file.stat().st_mtime
    if mtime != _instructions["mtime"]:
        _instructions.update(mtime=mtime, text=config.instructions_file.read_text(encoding="utf-8").strip())
    return _instructions["text"]


# ---------------------------------------------------------------- semantic search (optional)

_semantic: dict[str, Any] = {"checked": False, "ok": False}


def semantic_available() -> bool:
    """Pop's semantic search needs sentence-transformers and embeddings (python main.py index ...)."""
    if not _semantic["checked"]:
        _semantic["checked"] = True
        try:
            import importlib.util

            if importlib.util.find_spec("sentence_transformers") is None:
                return False
            from app.db import embedding_count

            _semantic["ok"] = embedding_count() > 0
        except Exception:  # noqa: BLE001 - optional feature
            _semantic["ok"] = False
    return _semantic["ok"]


# ---------------------------------------------------------------- app

app = FastAPI(title="advisor. (built on Pop)", version="1.0.0", docs_url=None, redoc_url=None, openapi_url=None)

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "; ".join([
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data:",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ]),
}


@app.middleware("http")
async def _headers(request: Request, call_next):
    response = await call_next(request)
    for k, v in SECURITY_HEADERS.items():
        response.headers.setdefault(k, v)
    return response


@app.on_event("startup")
def _startup() -> None:
    data.load()
    instructions()  # fail fast if the file is missing
    mode = "Claude" if config.api_key else "offline mode (set ANTHROPIC_API_KEY in .env to use Claude)"
    print(f"advisor.: {data.health['courses']} courses, {data.health['sections']} sections for {data.health['semester']}. Chat: {mode}")


def error(status: int, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"error": message, **extra}, status_code=status, headers={"Cache-Control": "no-store"})


_hits: dict[str, list[float]] = defaultdict(list)


def rate_limited(request: Request) -> bool:
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    window = 300.0
    hits = [t for t in _hits[ip] if now - t < window]
    hits.append(now)
    _hits[ip] = hits
    if len(_hits) > 5000:
        for key in [k for k, v in _hits.items() if not any(now - t < window for t in v)]:
            del _hits[key]
    return len(hits) > config.rate_limit


async def read_json(request: Request, limit: int) -> Any:
    body = await request.body()
    if len(body) > limit:
        raise ValueError("too large")
    return json.loads(body or b"null")


def clean_messages(raw: Any) -> list[dict[str, str]]:
    """Keep only valid turns, merge repeats, start and end with the student."""
    if not isinstance(raw, list):
        return []
    out: list[dict[str, str]] = []
    for m in raw[-30:]:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant") or not isinstance(m.get("content"), str):
            continue
        content = m["content"].strip()[:12000]
        if not content:
            continue
        if out and out[-1]["role"] == m["role"]:
            out[-1]["content"] += f"\n\n{content}"
        else:
            out.append({"role": m["role"], "content": content})
    while out and out[0]["role"] != "user":
        out.pop(0)
    while out and out[-1]["role"] != "user":
        out.pop()
    return out


def student_context(value: Any) -> str:
    """STUDENT CONTEXT text from the page (the student's own data), size-capped."""
    text = value if isinstance(value, str) else ""
    return text[:200_000] or "STUDENT CONTEXT\n(none)"


def system_blocks(context_text: str, question: str = "") -> list[dict[str, Any]]:
    blocks = [
        {"type": "text", "text": instructions()},
        {"type": "text", "text": data.course_data, "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": context_text},
    ]
    # research questions get the best-matching faculty from IIT's directory
    faculty = faculty_block(data.faculty, question, data.faculty_read_on)
    if faculty:
        blocks.append({"type": "text", "text": faculty})
    return blocks


# ----- data and health


@app.get("/api/health")
def health() -> JSONResponse:
    mode = "claude" if config.api_key else "offline"
    return JSONResponse({"ok": True, "mode": mode, "model": config.model if config.api_key else None,
                         **data.health, "semantic": semantic_available(), "foundation": "pop"},
                        headers={"Cache-Control": "no-store"})


@app.get("/data/{name}")
def data_file(name: str) -> Response:
    body = data.files.get(name)
    if body is None:
        return error(404, "Not found.")
    return Response(body, media_type="application/json; charset=utf-8", headers={"Cache-Control": "no-cache"})


# ----- chat


@app.post("/api/chat")
async def chat(request: Request):
    if rate_limited(request):
        return error(429, "Too many questions in a short time. Wait a few minutes and try again.")
    try:
        body = await read_json(request, 512 * 1024)
    except ValueError:
        return error(400, 'Send JSON: { "messages": [...] }.')
    messages = clean_messages((body or {}).get("messages") if isinstance(body, dict) else None)
    if not messages:
        return error(400, "Ask a question first.")
    if not config.api_key:
        return error(503, "No Claude API key is set on the server.", mode="offline")
    context_text = student_context(body.get("studentContext"))

    async def events():
        def send(obj: dict) -> bytes:
            return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode("utf-8")

        yield send({"type": "meta", "mode": "claude", "model": config.model})
        try:
            stop = None
            async for item in stream_claude(api_key=config.api_key, base_url=config.base_url, model=config.model,
                                            max_tokens=config.max_tokens, system=system_blocks(context_text, messages[-1]["content"]),
                                            messages=messages):
                if "text" in item:
                    yield send({"type": "text", "text": item["text"]})
                else:
                    stop = item.get("stop_reason")
            if stop == "max_tokens":
                yield send({"type": "text", "text": "\n\n_(Answer cut short. Ask me to continue.)_"})
            yield send({"type": "done"})
        except ClaudeError as exc:
            yield send({"type": "error", "message": str(exc)})
        except asyncio.CancelledError:  # the student closed the page or pressed Stop
            raise
        except Exception as exc:  # noqa: BLE001
            print(f"[chat] {exc!r}")
            yield send({"type": "error", "message": "Could not reach the Claude API. Check your internet connection and try again."})

    return StreamingResponse(events(), media_type="text/event-stream; charset=utf-8",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


# ----- plan


# Answers for repeated plan and transcript requests: the same input gets the same output.
_answers: "OrderedDict[str, tuple[str, str | None]]" = OrderedDict()
_ANSWERS_MAX = 300


def _cache_key(*parts: str) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(str(p).encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()


def _remember(key: str, value: tuple[str, str | None]) -> None:
    _answers[key] = value
    _answers.move_to_end(key)
    while len(_answers) > _ANSWERS_MAX:
        _answers.popitem(last=False)


@app.post("/api/plan")
async def plan(request: Request):
    if rate_limited(request):
        return error(429, "Too many requests in a short time. Wait a few minutes and try again.")
    try:
        body = await read_json(request, 512 * 1024)
    except ValueError:
        return error(400, 'Send JSON: { "studentContext": "...", "userText": "..." }.')
    if not isinstance(body, dict) or not isinstance(body.get("studentContext"), str):
        return error(400, 'Send JSON: { "studentContext": "...", "userText": "..." }.')
    if not config.api_key:
        return error(503, "No Claude API key is set on the server.", mode="offline")
    user_text = str(body.get("userText") or "Make my recommended plan now.")[:40_000]
    # the same request gets the same plan (temperature 0, and a cache for exact repeats)
    key = _cache_key("plan", config.model, instructions(), body["studentContext"], user_text)
    try:
        if key in _answers:
            text, stop = _answers[key]
        else:
            text, stop = await call_claude(api_key=config.api_key, base_url=config.base_url, model=config.model, max_tokens=8000,
                                           system=system_blocks(student_context(body["studentContext"])),
                                           messages=[{"role": "user", "content": user_text}], temperature=0)
            if stop != "max_tokens":
                _remember(key, (text, stop))
    except ClaudeError as exc:
        return error(502, str(exc))
    except Exception as exc:  # noqa: BLE001
        print(f"[plan] {exc!r}")
        return error(502, "Could not reach the advisor.")
    return JSONResponse({"text": text, "stopReason": stop, "model": config.model}, headers={"Cache-Control": "no-store"})


# ----- transcript

TRANSCRIPT_PROMPT = (ROOT / "app" / "advisor" / "transcript_prompt.txt").read_text(encoding="utf-8").strip()
MEDIA = {"application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"}
_B64 = re.compile(r"^[A-Za-z0-9+/=\s]+$")


def _extract_json(text: str) -> Any:
    s = re.sub(r"\s*```$", "", re.sub(r"^```(?:json)?\s*", "", str(text or "").strip(), flags=re.I))
    start, end = s.find("{"), s.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON")
    return json.loads(s[start:end + 1])


@app.post("/api/transcript")
async def transcript(request: Request):
    if rate_limited(request):
        return error(429, "Too many requests in a short time. Wait a few minutes and try again.")
    if not config.api_key:
        return error(503, "Reading transcripts with Claude needs ANTHROPIC_API_KEY on the server. "
                          "You can still upload a text-based PDF, an .html or .txt file, or paste the text.")
    try:
        body = await read_json(request, 12 * 1024 * 1024)
    except ValueError:
        return error(413, "The file is too large (limit about 8 MB).")
    body = body if isinstance(body, dict) else {}
    content: list[dict[str, Any]] = []
    file = body.get("file")
    if isinstance(file, dict):
        media, b64 = str(file.get("mediaType") or ""), file.get("data")
        if media not in MEDIA:
            return error(400, "Claude can read PDF, PNG, JPEG, GIF, or WebP files.")
        if not isinstance(b64, str) or not _B64.match(b64):
            return error(400, "The file data is not valid.")
        kind = "document" if media == "application/pdf" else "image"
        content.append({"type": kind, "source": {"type": "base64", "media_type": media, "data": re.sub(r"\s", "", b64)}})
        content.append({"type": "text", "text": "List every course on this transcript as JSON."})
    elif isinstance(body.get("text"), str) and body["text"].strip():
        content.append({"type": "text", "text": f"List every course on this transcript as JSON.\n\n<transcript>\n{body['text'][:60000]}\n</transcript>"})
    else:
        return error(400, "Send a transcript file or text.")
    # the same file always reads the same way (temperature 0, and a cache for exact repeats)
    key = _cache_key("transcript", config.model, TRANSCRIPT_PROMPT, json.dumps(content, sort_keys=True))
    try:
        if key in _answers:
            text, stop = _answers[key]
        else:
            text, stop = await call_claude(api_key=config.api_key, base_url=config.base_url, model=config.model, max_tokens=8000,
                                           system=TRANSCRIPT_PROMPT, messages=[{"role": "user", "content": content}], temperature=0)
            if stop != "max_tokens":
                _remember(key, (text, stop))
    except ClaudeError as exc:
        return error(502, f"Claude could not read the transcript: {exc}")
    except Exception as exc:  # noqa: BLE001
        print(f"[transcript] {exc!r}")
        return error(502, "Could not reach the Claude API. Try again.")
    try:
        parsed = _extract_json(text)
    except ValueError:
        return error(502, "Claude did not return a course list. Try a clearer file or paste the text.")
    courses = [c for c in (parsed.get("courses") or []) if isinstance(c, dict)][:400] if isinstance(parsed, dict) else []
    warnings = [w[:300] for w in (parsed.get("warnings") or []) if isinstance(w, str)][:20]
    if stop == "max_tokens":
        warnings.append("The transcript was long and the list may be cut short. Check the last term.")
    majors = [m[:120] for m in (parsed.get("majors") or []) if isinstance(m, str)][:4]
    return JSONResponse({"courses": courses, "warnings": warnings, "majors": majors}, headers={"Cache-Control": "no-store"})


# ----- faculty search


@app.get("/api/faculty")
def faculty_search(q: str = "", dept: str = "", limit: int = 10) -> JSONResponse:
    if not data.faculty:
        return error(503, "Faculty data is not loaded. See README: Faculty search.")
    hits = data.faculty.search(q[:300], dept=dept[:120], limit=max(1, min(int(limit), 50)))
    return JSONResponse({"results": hits, "readOn": data.faculty_read_on}, headers={"Cache-Control": "no-cache"})


@app.get("/api/faculty/departments")
def faculty_departments() -> JSONResponse:
    return JSONResponse({"departments": data.faculty.departments if data.faculty else []})


# ----- Pop's semantic search


@app.post("/api/search/semantic")
async def search_semantic(request: Request):
    if not semantic_available():
        return error(503, "Semantic search is not set up. Install requirements.txt and run: python main.py index spring 2027")
    try:
        body = await read_json(request, 16 * 1024)
        query = str(body.get("query") or "").strip()[:300]
        limit = max(1, min(int(body.get("limit") or 15), 50))
    except (ValueError, TypeError, AttributeError):
        return error(400, 'Send JSON: { "query": "..." }.')
    if not query:
        return error(400, "Type what you are looking for.")
    from app.api import embed_query  # loads the model on first use
    from app.db import semantic_search

    vector = await asyncio.to_thread(embed_query, query)
    hits = await asyncio.to_thread(semantic_search, vector, data.health["semester"], limit)
    return JSONResponse({"results": [{"code": h.course_name, "title": h.title, "score": round(h.score, 4)} for h in hits]})


# ----- the page


@app.api_route("/{path:path}", methods=["GET", "HEAD"])
def page(path: str) -> Response:
    if path.startswith("api/") or path.startswith("data/"):
        return error(404, "Not found.")
    target = (WEB / (path or "index.html")).resolve()
    if target != WEB and WEB not in target.parents:
        return error(404, "Not found.")
    if target.is_dir():
        target = target / "index.html"
    if not target.is_file():
        return error(404, "Not found.")
    return FileResponse(target, headers={"Cache-Control": "no-cache"})
