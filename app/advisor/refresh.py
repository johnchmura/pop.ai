"""Refresh seed/ from IIT's public pages, and optionally push the new seed to GitHub.

Render runs this as a cron job (render.yaml). The web service rebuilds its database from seed/
on every deploy, so a push here leads to a deploy with fresh data.

  sections  IIT's Course Status Report, for the semester in seed/advisor.json (every run)
  faculty   IIT's online directory (iit.edu/directory/people), when seed/faculty.json is a week old

A refresh that returns much less data than the current seed is treated as a failed scrape,
and the old file is kept.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable
from urllib.parse import urljoin

from app.db import ROOT, term_code
from app.advisor.faculty import clean_record
from app.advisor.store import SEED_DIR

BASE_URL = "https://www.iit.edu"
DIRECTORY_URL = f"{BASE_URL}/directory/people"
FACULTY_TYPE = 21  # the directory's "Faculty" filter
USER_AGENT = "pop-advisor/1.0 (Illinois Tech course advisor; https://github.com/johnchmura/pop.ai)"

MIN_SHARE = {"sections": 0.6, "faculty": 0.8}
FACULTY_MAX_AGE_DAYS = 7


def log(msg: str) -> None:
    print(msg, flush=True)


def dump(payload) -> str:
    return json.dumps(payload, indent=1, ensure_ascii=False) + "\n"


# ----- sections -----------------------------------------------------------------------------


def current_semester(seed_dir: Path = SEED_DIR) -> tuple[str, int]:
    label = json.loads((seed_dir / "advisor.json").read_text(encoding="utf-8"))["semester"]
    season, year = label.split()
    return season.lower(), int(year)


def section_file(seed_dir: Path = SEED_DIR) -> Path:
    season, year = current_semester(seed_dir)
    return seed_dir / f"{season}_{year}.json"


def sections_payload(season: str, year: int, courses: list[dict]) -> dict:
    """The seed file shape: {semester_name, term_code, courses: [{name, title, ..., sections: {label: buckets}}]}."""
    label = f"{season.capitalize()} {year}"
    return {
        "semester_name": label,
        "term_code": term_code(season, year),
        "courses": [
            {"name": c["name"], "title": c["title"], "description": "", "attributes": "", "sections": {label: c["sections"]}}
            for c in sorted(courses, key=lambda c: c["name"])
        ],
    }


def refresh_sections(seed_dir: Path = SEED_DIR, fetch_rows: Callable | None = None) -> dict | None:
    sys.path.insert(0, str(ROOT / "scraping"))
    import scrape_courses  # noqa: E402

    season, year = current_semester(seed_dir)
    rows = (fetch_rows or scrape_courses.fetch_rows)(term_code(season, year))
    return sections_payload(season, year, scrape_courses.group_rows(rows))


# ----- faculty ------------------------------------------------------------------------------


def _text(node) -> str:
    text = re.sub(r"\s+", " ", node.get_text(" ") if node else "").strip()
    return re.sub(r" ([,.;:!?)])", r"\1", text)  # no space before punctuation after an inline tag


def directory_links(html: str) -> tuple[list[str], bool]:
    """Profile URLs on one directory page, and whether there is a next page."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    urls = []
    for a in soup.select("a[href*='/directory/people/']"):
        url = urljoin(BASE_URL, a.get("href", "").split("?")[0].split("#")[0]).rstrip("/")
        if url.startswith(DIRECTORY_URL + "/") and url not in urls:
            urls.append(url)
    more = soup.select_one("a[rel='next'], li.pager__item--next a") is not None
    return urls, more


def _section_items(heading) -> list[str]:
    """Text items under a heading, up to the next heading: list items, and paragraph lines."""
    items = []
    for sib in heading.find_next_siblings():
        if sib.name in ("h2", "h3", "h4"):
            break
        if sib.name in ("ul", "ol"):
            items += [_text(li) for li in sib.find_all("li")]
        elif sib.name == "p":
            for br in sib.find_all("br"):
                br.replace_with("\n")
            items += [re.sub(r"\s+", " ", line).strip() for line in sib.get_text().split("\n")]
    return [i for i in items if i]


SECTION_KEYS = (("research interests", "research_interests"), ("research areas", "research_interests"), ("publications", "publications"))
SKIP_HEADINGS = {"tags:", "contact information", "learn more..."}


def parse_profile(url: str, html: str) -> dict:
    """The fields the advisor keeps (see faculty.clean_record) from one profile page."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    record: dict = {"profile_url": url, "name": _text(soup.find("h1"))}
    pos = soup.find("div", class_="hero__positions")
    titles = [_text(x) for x in pos.find_all(["li", "p"])] if pos else []
    record["titles"] = [t for t in titles if t] or ([_text(pos)] if pos and _text(pos) else [])
    departments = []
    tags = soup.find("div", class_="listing-item__tags")
    if tags:
        for i, ul in enumerate(tags.find_all("ul")):
            for a in ul.find_all("a"):
                if i > 0 and "profile_type" not in a.get("href", "") and _text(a):
                    departments.append(_text(a))
    record["departments"] = departments
    mail = soup.find("a", href=re.compile(r"^mailto:", re.I))
    record["email"] = mail["href"].split(":", 1)[1].split("?")[0].strip() if mail else ""
    scholar = soup.find("a", href=re.compile(r"scholar\.google\."))
    record["google_scholar_url"] = scholar["href"].strip() if scholar else ""
    record.update(research_interests=[], publications=[], additional_sections={})
    for heading in soup.select("article.detail-page h2, article.detail-page h3, article.detail-page h4"):
        name = _text(heading)
        low = name.lower()
        if low in SKIP_HEADINGS:
            continue
        key = next((k for word, k in SECTION_KEYS if word in low), None)
        items = _section_items(heading)
        if key:
            record[key].extend(items)
        elif items:
            record["additional_sections"][name] = items
    return record


def refresh_faculty(get: Callable[[str], str], pause: float = 0.4, max_pages: int = 150) -> dict:
    """Read every faculty profile in the directory. get(url) returns the page HTML or raises."""
    urls: list[str] = []
    for page in range(max_pages):
        query = f"?profile_type={FACULTY_TYPE}" + (f"&page={page}" if page else "")
        found, more = directory_links(get(DIRECTORY_URL + query))
        urls += [u for u in found if u not in urls]
        if not more:
            break
        time.sleep(pause)
    else:
        raise RuntimeError("directory has more pages than expected; stopping")
    log(f"  directory: {len(urls)} profiles")
    records = []
    for n, url in enumerate(urls, 1):
        record = clean_record(parse_profile(url, get(url)))
        if record:
            records.append(record)
        if n % 100 == 0:
            log(f"  profiles: {n}/{len(urls)}")
        time.sleep(pause)
    return {"read_on": dt.date.today().isoformat(), "faculty": records}


def http_get(url: str, retries: int = 3) -> str:
    import requests

    for attempt in range(retries):
        try:
            r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=30)
            r.raise_for_status()
            return r.text
        except requests.RequestException:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)
    raise AssertionError("unreachable")


def faculty_is_stale(seed_dir: Path = SEED_DIR, today: dt.date | None = None) -> bool:
    path = seed_dir / "faculty.json"
    if not path.exists():
        return True
    try:
        read_on = dt.date.fromisoformat(json.loads(path.read_text(encoding="utf-8")).get("read_on", ""))
    except ValueError:
        return True
    return ((today or dt.date.today()) - read_on).days >= FACULTY_MAX_AGE_DAYS


# ----- checks and writing -------------------------------------------------------------------


def count(kind: str, payload: dict) -> int:
    return len(payload.get("courses" if kind == "sections" else "faculty") or [])


def check_size(kind: str, new: dict, old_path: Path) -> None:
    """Refuse a result much smaller than what the seed has now (a broken page, a block, an outage)."""
    got = count(kind, new)
    if not got:
        raise RuntimeError(f"{kind}: the scrape returned nothing")
    if old_path.exists():
        had = count(kind, json.loads(old_path.read_text(encoding="utf-8")))
        if had and got < MIN_SHARE[kind] * had:
            raise RuntimeError(f"{kind}: only {got} found, the seed has {had}; keeping the seed")


def write_if_changed(path: Path, payload: dict) -> bool:
    text = dump(payload)
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.write_text(text, encoding="utf-8")
    return True


# ----- pushing ------------------------------------------------------------------------------


def _git(args: list[str], cwd: Path, secret: str = "") -> str:
    done = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    out = (done.stdout + done.stderr).replace(secret, "***") if secret else done.stdout + done.stderr
    if done.returncode:
        raise RuntimeError(f"git {args[0]} failed: {out.strip()[-400:]}")
    return out


def remote_url(token: str, repo: str) -> str:
    return f"https://x-access-token:{token}@github.com/{repo}.git"


def push_seed(files: list[Path], message: str) -> bool:
    """Commit the changed seed files to GitHub. Needs GITHUB_TOKEN with write access to the repository."""
    token = os.getenv("GITHUB_TOKEN", "").strip()
    repo = os.getenv("DATA_REPO") or os.getenv("RENDER_GIT_REPO_SLUG") or ""
    branch = os.getenv("DATA_BRANCH") or os.getenv("RENDER_GIT_BRANCH") or "master"
    if not token or not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        raise RuntimeError("set GITHUB_TOKEN and DATA_REPO (owner/repo) to push")
    url = remote_url(token, repo)
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "repo"
        _git(["clone", "--depth", "1", "--branch", branch, url, str(work)], Path(tmp), token)
        for f in files:
            shutil.copyfile(f, work / "seed" / f.name)
        _git(["add", *[f"seed/{f.name}" for f in files]], work)
        if not _git(["status", "--porcelain"], work).strip():
            log("GitHub already has this data; nothing to push")
            return False
        _git(["-c", "user.name=pop-advisor data bot", "-c", "user.email=data-bot@users.noreply.github.com",
              "commit", "-m", message], work)
        _git(["push", "origin", f"HEAD:{branch}"], work, token)
    log(f"pushed to {repo} ({branch})")
    return True


# ----- main ---------------------------------------------------------------------------------


def run(*, sections: bool = True, faculty: str = "auto", push: bool = False, seed_dir: Path = SEED_DIR,
        fetch_rows: Callable | None = None, get: Callable[[str], str] = http_get) -> int:
    """faculty: 'auto' (when a week old), 'yes', or 'no'. Returns 0 when every step worked, else 1."""
    changed: list[Path] = []
    notes: list[str] = []
    failed = False
    if sections:
        path = section_file(seed_dir)
        try:
            log(f"sections: reading the Course Status Report for {path.stem}")
            payload = refresh_sections(seed_dir, fetch_rows)
            check_size("sections", payload, path)
            if write_if_changed(path, payload):
                changed.append(path)
                notes.append(f"{count('sections', payload)} courses")
            log(f"sections: {count('sections', payload)} courses ({'changed' if path in changed else 'no change'})")
        except Exception as exc:  # keep going: faculty can still refresh
            failed = True
            log(f"sections: FAILED, seed kept. {exc}")
    if faculty == "yes" or (faculty == "auto" and faculty_is_stale(seed_dir)):
        path = seed_dir / "faculty.json"
        try:
            log("faculty: reading IIT's online directory")
            payload = refresh_faculty(get)
            check_size("faculty", payload, path)
            if write_if_changed(path, payload):
                changed.append(path)
                notes.append(f"{count('faculty', payload)} faculty")
            log(f"faculty: {count('faculty', payload)} profiles ({'changed' if path in changed else 'no change'})")
        except Exception as exc:
            failed = True
            log(f"faculty: FAILED, seed kept. {exc}")
    else:
        log("faculty: skipped" if faculty == "no" else "faculty: less than a week old, skipped")
    if changed and push:
        try:
            push_seed(changed, f"Refresh data from IIT: {', '.join(notes)}")
        except Exception as exc:
            failed = True
            log(f"push: FAILED. {exc}")
    elif not changed:
        log("nothing changed")
    return 1 if failed else 0
