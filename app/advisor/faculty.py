"""Faculty search: match students with IIT faculty by research topic.

The data comes from IIT's online directory (iit.edu/directory/people), collected the way
Ishaan Goel's iit-faculty-search scraper does it (https://github.com/igoeldc/iit-faculty-search).
It is stored in Pop's database (advisor_data "faculty") and loaded from seed/faculty.json.

Search is BM25 over weighted fields (research interests and names count most), in plain Python,
so it needs no extra libraries.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import Any

# fields and how much a word in them counts
WEIGHTS = {"name": 3.0, "research": 3.0, "departments": 2.0, "titles": 1.5, "publications": 1.0}
K1, B = 1.2, 0.75

STOP = set("""
a an and are as at be by can could do does for from has have how i in into is it its me my of on or our so
that the their them then there these they this to us was we what when where which who whom why will with
would you your about any some all more most other than too very also just get got like want wants wanted
need needs looking look find show tell know someone anyone people person one ones good best great
research researcher researchers researching professor professors prof faculty lab labs laboratory mentor
mentors advisor advisors advise work works working study studies studying student students undergraduate
undergrad phd graduate interest interests interested area areas field fields topic topics iit illinois tech
department departments course courses class classes email contact reach out join help project projects
""".split())

_WORD = re.compile(r"[a-z0-9]+")
# a question about research or faculty (then the chat gets faculty matches)
RESEARCH_INTENT = re.compile(
    r"\b(research|researchers?|professors?|faculty|labs?|laborator(y|ies)|mentors?|ph\.?d|thesis|publications?|"
    r"work with|works on|who (works|studies|does|teaches)|reach out|undergraduate research|scholar)\b",
    re.I,
)

RESEARCH_HEADINGS = re.compile(r"research|expertise|interest|focus|specializ", re.I)
# emeritus and adjunct faculty rarely take research students: still shown, ranked a little lower
RANK_FACTOR = ((re.compile(r"emerit", re.I), 0.6), (re.compile(r"\badjunct\b", re.I), 0.75))


def short(text: str, limit: int = 120) -> str:
    """Trim long research entries (some profiles hold a whole biography there) at a word break."""
    text = str(text or "").strip()
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(",;:")
    return f"{cut}…"


def excerpt(text: str, stems: set[str], limit: int = 120) -> str:
    """A long entry shortened around the first search word, so the match stays visible."""
    text = str(text or "").strip()
    if len(text) <= limit:
        return text
    low = text.lower()
    at = min((i for i in (low.find(st) for st in stems) if i >= 0), default=-1)
    if at < 40:
        return short(text, limit)
    start = text.rfind(" ", 0, at - 25) + 1
    return "…" + short(text[start:], limit)


def stem(word: str) -> str:
    """Light stemming so related words meet: robots/robotics -> robot, studies -> study, learning -> learn."""
    if len(word) > 6 and word.endswith("ics"):
        return word[:-3]
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 5 and word.endswith("ing"):
        return word[:-3]
    if len(word) > 3 and word.endswith("s") and not word.endswith(("ss", "us", "is")):
        return word[:-1]
    return word


def tokens(text: str, drop_stop: bool = True) -> list[str]:
    out = []
    for w in _WORD.findall(str(text or "").lower()):
        if drop_stop and (w in STOP or len(w) < 2):
            continue
        out.append(stem(w))
    return out


def _list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v or "").strip()]
    return [str(value).strip()] if str(value or "").strip() else []


def clean_record(raw: dict) -> dict | None:
    """Keep the fields the advisor uses. Records without a name or profile link are dropped."""
    name = str(raw.get("name") or "").strip()
    url = str(raw.get("profile_url") or "").strip()
    if not name or not url.startswith("https://www.iit.edu/"):
        return None
    research = _list(raw.get("research_interests"))
    # some profiles list research under another heading ("Areas of Expertise", "Research Focus")
    for heading, items in (raw.get("additional_sections") or {}).items():
        if RESEARCH_HEADINGS.search(str(heading)):
            research.extend(_list(items))
    seen: set[str] = set()
    research = [r for r in research if not (r.lower() in seen or seen.add(r.lower()))]
    email = str(raw.get("email") or "").strip()
    scholar = str(raw.get("google_scholar_url") or "").strip()
    return {
        "name": name,
        "slug": url.rstrip("/").rsplit("/", 1)[-1],
        "titles": _list(raw.get("titles"))[:4],
        "departments": _list(raw.get("departments"))[:6],
        "email": email if re.fullmatch(r"[^@\s]+@[^@\s]+\.[a-z]{2,}", email, re.I) else "",
        "profile_url": url,
        "google_scholar_url": scholar if scholar.startswith("https://scholar.google.") else "",
        "research_interests": research[:40],
        "publications": _list(raw.get("publications"))[:40],
    }


class FacultyIndex:
    def __init__(self, records: list[dict]):
        self.records = [r for r in (clean_record(x) if "slug" not in x else x for x in records) if r]
        self.docs: list[Counter] = []
        self.lengths: list[float] = []
        df: Counter = Counter()
        for r in self.records:
            tf: Counter = Counter()
            fields = {
                "name": r["name"],
                "research": " ".join(r["research_interests"]),
                "departments": " ".join(r["departments"]),
                "titles": " ".join(r["titles"]),
                "publications": " ".join(r["publications"]),
            }
            for field, text in fields.items():
                for t in tokens(text):
                    tf[t] += WEIGHTS[field]
            self.docs.append(tf)
            self.lengths.append(sum(tf.values()))
            df.update(tf.keys())
        n = len(self.records) or 1
        self.avg_len = (sum(self.lengths) / n) or 1.0
        self.idf = {t: math.log(1 + (n - d + 0.5) / (d + 0.5)) for t, d in df.items()}
        self.departments = sorted({d for r in self.records for d in r["departments"]})

    def search(self, query: str, dept: str = "", limit: int = 10) -> list[dict]:
        q = list(dict.fromkeys(tokens(query)))
        if not q:
            return []
        phrase = " ".join(_WORD.findall(str(query).lower()))
        scored = []
        for i, tf in enumerate(self.docs):
            r = self.records[i]
            if dept and dept not in r["departments"]:
                continue
            score = 0.0
            for t in q:
                f = tf.get(t)
                if f:
                    score += self.idf[t] * f * (K1 + 1) / (f + K1 * (1 - B + B * self.lengths[i] / self.avg_len))
            if not score:
                continue
            # an exact research interest match ("machine learning") counts extra
            if len(q) > 1 and any(phrase and phrase in ri.lower() for ri in r["research_interests"]):
                score *= 1.5
            titles = " ".join(r["titles"])
            for pattern, factor in RANK_FACTOR:
                if pattern.search(titles):
                    score *= factor
            scored.append((score, i))
        scored.sort(key=lambda x: (-x[0], self.records[x[1]]["name"]))
        out = []
        for score, i in scored[:limit]:
            r = self.records[i]
            # entries with more of the search words first, then shorter ones
            qs = set(q)
            hits = [(len(set(tokens(ri)) & qs), ri) for ri in r["research_interests"]]
            matched = [excerpt(ri, qs) for n_hit, ri in sorted((h for h in hits if h[0]), key=lambda h: (-h[0], len(h[1])))]
            out.append({**{k: r[k] for k in ("name", "slug", "titles", "departments", "email", "profile_url", "google_scholar_url")},
                        "research_interests": [short(ri) for ri in r["research_interests"][:12]], "matched": matched[:6],
                        "score": round(score, 3)})
        return out


def faculty_block(index: FacultyIndex | None, question: str, read_on: str = "", limit: int = 6) -> str:
    """The FACULTY MATCHES text added to Claude's context for research questions ('' otherwise)."""
    if not index or not index.records or not RESEARCH_INTENT.search(question or ""):
        return ""
    hits = index.search(question, limit=limit)
    source = f"IIT's online directory{f', read {read_on}' if read_on else ''}"
    if not hits:
        return (f"FACULTY MATCHES ({source}): no faculty matched this question's topic. Do not name faculty from memory. "
                "Ask the student which topic or field interests them, or suggest searching the app.")
    lines = [f"FACULTY MATCHES ({source}; best matches for this question, best first). Name only these people when you suggest faculty:"]
    for n, h in enumerate(hits, 1):
        research = "; ".join((h["matched"] or h["research_interests"])[:5]) or "not listed"
        parts = [f"{n}. {h['name']}", ", ".join(h["titles"][:2]) or "Faculty", ", ".join(h["departments"][:3])]
        lines.append(" | ".join(p for p in parts if p) + f" | Research: {research}"
                     + (f" | Email: {h['email']}" if h["email"] else "") + f" | Profile: {h['profile_url']}")
    return "\n".join(lines)
