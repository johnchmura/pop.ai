#!/usr/bin/env python3
"""One-time tool: build seed/ from a checkout of the old Node advisor (WillMo2198/advisor).

    python scripts/seed_from_node_advisor.py ../advisor

Writes:
  seed/catalog.json          Pop catalog format (same as www/data/full_catalog.json)
  seed/advisor.json          departments, catalog source, prerequisite fixes, schedule semester
  seed/forecast.json         tentative CS future offerings
  seed/programs.json         the 50 checked degree programs
  seed/spring_2027.json      real sections (a Pop semester export), if the checkout has one
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.advisor.prereq import clean_prereq_text, parse_prereq  # noqa: E402


def main() -> None:
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "../advisor").resolve()
    data = src / "data"
    catalog = json.loads((data / "catalog.json").read_text(encoding="utf-8"))
    out = ROOT / "seed"
    out.mkdir(exist_ok=True)

    pop_catalog = []
    fixes = {}
    for c in catalog["courses"]:
        pop_catalog.append({
            "code": c["code"], "title": c["title"], "description": c["description"],
            "credits": c["credits"], "lecture": "", "lab": "",
            "prerequisites": c["prereqText"], "corequisites": "", "satisfies": c["satisfies"],
        })
        fix = {}
        if parse_prereq(c["prereqText"]) != c["prereq"]:
            # a hand-checked tree (the catalog wording is unclear). It applies only while the
            # catalog still prints the same wording; a new wording from Pop's scraper wins.
            fix["prereq"] = c["prereq"]
            fix["forText"] = clean_prereq_text(c["prereqText"])
        if c.get("note"):
            fix["note"] = c["note"]
        if c.get("bridge"):
            fix["bridge"] = True
        if fix:
            fixes[c["code"]] = fix

    (out / "catalog.json").write_text(json.dumps(pop_catalog, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    sample = json.loads((data / "sample-sections.json").read_text(encoding="utf-8"))
    (out / "advisor.json").write_text(json.dumps({
        "catalogSource": catalog["source"],
        "departments": catalog["departments"],
        "prereqFixes": fixes,
        "semester": sample["semester_name"],
        "termCode": sample["term_code"],
    }, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    shutil.copyfile(data / "forecast.json", out / "forecast.json")
    shutil.copyfile(data / "programs.json", out / "programs.json")
    sections = json.loads((data / "sections.json").read_text(encoding="utf-8"))
    if sections.get("sample") is False:
        season, year = sections["semester_name"].lower().split()
        payload = {"semester_name": sections["semester_name"], "term_code": sections["term_code"], "courses": sections["courses"]}
        (out / f"{season}_{year}.json").write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"seed/: {len(pop_catalog)} catalog courses, {len(fixes)} prerequisite fixes, "
          f"{len(json.loads((out / 'programs.json').read_text())['programs'])} programs")


if __name__ == "__main__":
    main()
