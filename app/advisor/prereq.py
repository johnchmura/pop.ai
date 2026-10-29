"""Prerequisite text -> AND / OR tree, the same shape the advisor page uses.

Tree nodes:
  {"type": "course", "code": "CS 331", "minGrade": "C", "concurrent": True}
  {"type": "and" | "or", "children": [...]}
  {"type": "text", "text": "Junior standing"}

"and" binds tighter than "or". "*" after a code means it may be taken at the same time.
This is a port of the advisor's JavaScript parser (scripts/catalog-extra.mjs); tests check both agree.
"""

from __future__ import annotations

import re
from typing import Any

CONCURRENT_NOTE = "An asterisk (*) designates a course which may be taken concurrently."
_TOKEN = re.compile(
    r"\(|\)|\band\b|\bor\b"
    r"|\b[A-Z]{2,4} \d{3}(?:-\d{3})?\*?(?:\s+with min\. grade of [A-D]\*?)?"
    r"|[^()]+?(?=\(|\)|\band\b|\bor\b|\b[A-Z]{2,4} \d{3}|$)"
)
_COURSE = re.compile(r"^([A-Z]{2,4} \d{3})(-\d{3})?(\*)?(?:\s+with min\. grade of ([A-D]))?(\*)?$")
_HAS_CODE = re.compile(r"\b[A-Z]{2,4} \d{3}\b")


def clean_prereq_text(raw: str | None) -> str:
    """The catalog wording without the asterisk note and trailing commas."""
    text = str(raw or "").replace(CONCURRENT_NOTE, "")
    return re.sub(r"[,\s]+$", "", text).strip()


def _tokenize(text: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in _TOKEN.finditer(text):
        s = m.group(0).strip()
        if not s:
            continue
        if s == "(":
            out.append({"k": "lp"})
        elif s == ")":
            out.append({"k": "rp"})
        elif s == "and":
            out.append({"k": "and"})
        elif s == "or":
            out.append({"k": "or"})
        else:
            cm = _COURSE.match(s)
            if cm and not cm.group(2):
                out.append({
                    "k": "course",
                    "code": cm.group(1),
                    "concurrent": bool(cm.group(3) or cm.group(5)),
                    "minGrade": cm.group(4) or "",
                })
            else:
                out.append({"k": "text", "text": re.sub(r"[*.]+$", "", s)})
    return out


def parse_prereq(raw: str | None) -> dict[str, Any] | None:
    """Text -> tree, or None for no prerequisite. Falls back to one text leaf when it cannot be read."""
    text = re.sub(r"\s+", " ", re.sub(r"[,\s]+$", "", str(raw or "").replace(CONCURRENT_NOTE, ""))).strip()
    if not text:
        return None
    if not _HAS_CODE.search(text):
        return {"type": "text", "text": re.sub(r"\.$", "", text)}
    toks = _tokenize(text)
    pos = 0

    def leaf(t: dict[str, Any]) -> dict[str, Any]:
        if t["k"] == "course":
            node: dict[str, Any] = {"type": "course", "code": t["code"]}
            if t["minGrade"]:
                node["minGrade"] = t["minGrade"]
            if t["concurrent"]:
                node["concurrent"] = True
            return node
        return {"type": "text", "text": t["text"]}

    def atom() -> dict[str, Any] | None:
        nonlocal pos
        if pos >= len(toks):
            return None
        t = toks[pos]
        if t["k"] == "lp":
            pos += 1
            n = either()
            if pos < len(toks) and toks[pos]["k"] == "rp":
                pos += 1
            return n
        if t["k"] in ("course", "text"):
            pos += 1
            return leaf(t)
        return None

    def join(kind: str, nxt) -> dict[str, Any] | None:
        nonlocal pos
        first = nxt()
        if not first:
            return None
        kids = [first]
        while pos < len(toks) and toks[pos]["k"] == kind:
            pos += 1
            n = nxt()
            if n:
                kids.append(n)
        return first if len(kids) == 1 else {"type": kind, "children": kids}

    def both() -> dict[str, Any] | None:
        return join("and", atom)

    def either() -> dict[str, Any] | None:
        return join("or", both)

    tree = either()
    if pos < len(toks):
        return {"type": "text", "text": text}  # not fully read: keep the printed text
    return tree
