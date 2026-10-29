"""Advisor data built from Pop's database.

The page loads four JSON files, in the same shapes the advisor has always used:
  /data/catalog.json    courses with prerequisite trees   (Pop: catalog_courses + advisor fixes)
  /data/sections.json   one semester's sections           (Pop: semesters + courses)
  /data/forecast.json   tentative future CS offerings      (advisor_data)
  /data/programs.json   degree programs                    (advisor_data)

COURSE DATA, the text Claude reads in every chat, is built here too (course_data_text).
It matches the advisor's JavaScript version (lib/context.js) character for character; a test checks it.
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
from typing import Any

from app.advisor.prereq import clean_prereq_text, parse_prereq
from app.advisor.store import get_value
from app.db import export_semester_payload

_CODE = re.compile(r"^\s*([A-Za-z]{2,4})[\s\-_]*(\d{3})\s*$")
TYPE_NAMES = {"STU": "Studio", "SEM": "Seminar", "PRA": "Practicum", "CLN": "Clinic"}


def normalize_code(text: Any) -> str:
    m = _CODE.match(str(text or ""))
    return f"{m.group(1).upper()} {m.group(2)}" if m else ""


def _number(code: str) -> int:
    return int(code.split(" ")[1])


def schedule_semester(conn: sqlite3.Connection) -> str:
    return get_value(conn, "semester", "Spring 2027")


# ---------------------------------------------------------------- JSON files


def _referenced_codes(programs: list[dict], forecast: dict | None) -> set[str]:
    """Course codes the degree rules or the forecast name (graduate courses some programs use)."""
    out: set[str] = set()
    for p in programs:
        for g in p.get("groups", []):
            for slot in g.get("slots") or []:
                for option in slot:
                    out.update(option)
            out.update((g.get("from") or {}).get("codes") or [])
        for t in p.get("tracks") or []:
            out.update(t.get("codes") or [])
    out.update((forecast or {}).get("courses", {}).keys())
    return out


def catalog_json(conn: sqlite3.Connection) -> dict[str, Any]:
    """Undergraduate courses (and graduate courses a program or the forecast names), with prerequisite trees."""
    fixes: dict[str, dict] = get_value(conn, "prereq_fixes", {})
    programs = get_value(conn, "programs", [])
    keep = _referenced_codes(programs, get_value(conn, "forecast"))
    courses = []
    for row in conn.execute("SELECT * FROM catalog_courses ORDER BY rowid"):
        code = normalize_code(row["code"])
        if not code or (_number(code) >= 500 and code not in keep):
            continue
        text = clean_prereq_text(row["prerequisites"])
        fix = fixes.get(code, {})
        prereq = fix["prereq"] if "prereq" in fix and fix.get("forText") == text else parse_prereq(text)
        course: dict[str, Any] = {
            "code": code,
            "title": row["title"],
            "credits": row["credits"] or "Variable",
            "description": row["description"],
            "satisfies": row["satisfies"],
            "prereqText": text,
            "prereq": prereq,
        }
        if fix.get("bridge"):
            course["bridge"] = True
        if fix.get("note") and (fix.get("forText") is None or fix.get("forText") == text):
            course["note"] = fix["note"]
        courses.append(course)
    return {
        "source": get_value(conn, "catalog_source", "Illinois Tech catalog (catalog.iit.edu), read by Pop's scraper."),
        "departments": get_value(conn, "departments", {}),
        "courses": courses,
    }


def sections_json(conn: sqlite3.Connection) -> dict[str, Any]:
    """The schedule semester's sections, as Pop exports them."""
    label = schedule_semester(conn)
    row = conn.execute("SELECT season, year, scraped_at FROM semesters WHERE label = ?", (label,)).fetchone()
    if not row:
        return {"semester_name": label, "term_code": "", "sample": False, "courses": [],
                "note": f"No {label} sections loaded. Run Pop's scraper (see README)."}
    payload = export_semester_payload(row["season"], row["year"], conn=conn)
    payload["sample"] = False
    payload["note"] = f"From IIT's Course Status Report through Pop, loaded {str(row['scraped_at'])[:10]}."
    return payload


def forecast_json(conn: sqlite3.Connection) -> dict[str, Any] | None:
    return get_value(conn, "forecast")


def programs_json(conn: sqlite3.Connection) -> dict[str, Any]:
    return {"programs": get_value(conn, "programs", [])}


# ---------------------------------------------------------------- index (port of public/js/core/catalog.js)


def _flatten_sections(sections: Any, fallback: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not isinstance(sections, dict):
        return out
    values = list(sections.values())
    flat = bool(values) and all(isinstance(v, list) for v in values)
    by_semester = {fallback: sections} if flat else sections
    for semester, buckets in by_semester.items():
        if not isinstance(buckets, dict):
            continue
        for bucket, items in buckets.items():
            if not isinstance(items, list):
                continue
            for s in items:
                avail = s.get("available")
                out.append({
                    "crn": str(s.get("crn") if s.get("crn") is not None else "").strip(),
                    "scheduleType": TYPE_NAMES.get(s.get("schedule_type")) or s.get("schedule_type") or "",
                    "bucket": s.get("type") or bucket,
                    "available": None if avail == "" or avail is None else _js_number(avail),
                    "meetings": [{
                        "days": str(m.get("days") or "").strip(),
                        "time": str(m.get("time") or "").strip(),
                        "where": str(m.get("where") or "").strip(),
                        "instructors": [i for i in m["instructors"] if i] if isinstance(m.get("instructors"), list)
                        else ([str(m["instructors"])] if m.get("instructors") else []),
                    } for m in (s.get("meetings") or [])],
                })
    return out


def _js_number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return math.nan


def _js_num_text(value: float) -> str:
    """Number -> text the way JavaScript prints it (12 not 12.0)."""
    if isinstance(value, float) and math.isnan(value):
        return "NaN"
    if float(value).is_integer():
        return str(int(value))
    return repr(float(value))


def _leaves(tree: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []

    def met_without(node: Any, code: str) -> bool:
        if not node:
            return True
        if node["type"] == "course":
            return node["code"] != code
        if node["type"] == "text":
            return True
        if node["type"] == "and":
            return all(met_without(ch, code) for ch in node["children"])
        return any(met_without(ch, code) for ch in node["children"])

    def walk(node: Any) -> None:
        if not node:
            return
        if node["type"] == "course":
            out.append({"code": node["code"], "concurrent": bool(node.get("concurrent")), "alternative": met_without(tree, node["code"])})
        elif node["type"] in ("and", "or"):
            for ch in node["children"]:
                walk(ch)

    walk(tree)
    return out


def build_index(catalog: dict, offerings: dict, forecast: dict | None) -> dict[str, Any]:
    semester = offerings.get("semester_name") or "Spring 2027"
    departments = catalog.get("departments") or {}
    courses: dict[str, dict[str, Any]] = {}
    for raw in catalog["courses"]:
        code = normalize_code(raw["code"])
        if not code:
            continue
        subject, number = code.split(" ")
        courses[code] = {**raw, "code": code, "subject": subject, "number": number, "level": int(number[0]) * 100,
                         "department": departments.get(subject, subject), "sections": [], "dependents": []}
    crn_map: dict[str, dict] = {}
    for off in offerings.get("courses") or []:
        code = normalize_code(off.get("name") or off.get("course_name") or off.get("code"))
        if not code:
            continue
        if code not in courses:
            subject, number = code.split(" ")
            courses[code] = {"code": code, "subject": subject, "number": number, "level": int(number[0]) * 100,
                             "title": off.get("title") or "", "credits": "", "description": off.get("description") or "",
                             "satisfies": off.get("attributes") or "", "prereqText": "", "prereq": None,
                             "department": departments.get(subject, subject), "sections": [], "dependents": [], "stub": True}
        course = courses[code]
        for section in _flatten_sections(off.get("sections"), semester):
            if not section["crn"]:
                continue
            section["course"] = code
            same = crn_map.get(section["crn"])
            if same and same["course"] == code:
                for m in section["meetings"]:
                    key = (m["days"], m["time"], m["where"])
                    if not any((x["days"], x["time"], x["where"]) == key for x in same["meetings"]):
                        same["meetings"].append(m)
                if section["scheduleType"] and section["scheduleType"] not in same["scheduleType"].split(" + "):
                    same["scheduleType"] += f" + {section['scheduleType']}"
                continue
            course["sections"].append(section)
            crn_map[section["crn"]] = section
    external: dict[str, list] = {}
    for course in courses.values():
        for leaf in _leaves(course.get("prereq")):
            target = courses.get(leaf["code"])
            entry = {"code": course["code"], "concurrent": leaf["concurrent"]}
            if target:
                if not any(d["code"] == course["code"] for d in target["dependents"]):
                    target["dependents"].append(entry)
            else:
                external.setdefault(leaf["code"], []).append(entry)
    for course in courses.values():
        course["dependents"].sort(key=lambda d: d["code"])
    if forecast and forecast.get("courses"):
        labels = {t["key"]: t["label"] for t in forecast.get("terms") or []}
        for course in courses.values():
            keys = forecast["courses"].get(course["code"])
            course["futureTerms"] = [labels.get(k, k) for k in keys] if keys is not None else None
            course["forecastNote"] = (forecast.get("notes") or {}).get(course["code"], "")
    ordered = sorted(courses.values(), key=lambda c: (c["subject"], int(c["number"])))
    return {"semester": semester, "termCode": offerings.get("term_code") or "", "sample": bool(offerings.get("sample")),
            "forecast": forecast, "source": catalog.get("source") or "", "courses": courses, "list": ordered,
            "crnMap": crn_map, "external": external}


# ---------------------------------------------------------------- COURSE DATA (port of lib/context.js)


def _js(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def compact_section(s: dict) -> str:
    parts = []
    for m in s["meetings"]:
        when = f"{m['days']} {m['time']}" if m["days"] and m["time"] and m["time"] != "TBA" else "no set time (online or TBA)"
        where = f", {m['where']}" if m["where"] and m["where"] not in ("TBA", "-") else ""
        who = f", {', '.join(m['instructors'])}" if m["instructors"] else ""
        parts.append(f"{when}{where}{who}")
    meetings = " / ".join(parts)
    bucket = s["bucket"]
    kind = (s["scheduleType"] or "Section") + (f" ({bucket})" if bucket and bucket != "Class" else "")
    seats = "" if s["available"] is None else f"; {_js_num_text(s['available'])} seats open"
    return f"CRN {s['crn']} {kind}: {meetings or 'no set time'}{seats}"


def program_lines(prog: dict) -> list[str]:
    lines = [f"DEGREE PROGRAM {prog['name']} ({prog['catalogYear']} catalog, {prog['totalCredits']} credits). Requirement groups:"]
    for g in prog["groups"]:
        rule = ""
        frm = g.get("from") or {}
        if g.get("slots"):
            rule = "; ".join(" or ".join(" + ".join(o) for o in slot) for slot in g["slots"])
        elif frm.get("codes") is not None:
            rule = f"{str(g['count']) + ' course' if g.get('count') else str(g['credits']) + ' credits'} from {', '.join(frm['codes'])}"
        elif frm.get("subjects") is not None:
            rule = (f"{g['credits']} credits from {'/'.join(frm['subjects'])}"
                    f"{' ' + str(frm['minLevel']) + '+' if frm.get('minLevel') else ''}"
                    f"{' except ' + ', '.join(frm['exclude']) if frm.get('exclude') is not None else ''}")
        lines.append(f"- {g['name']} ({g['credits']} cr): {rule}{' ' + g['note'] if g.get('note') else ''}")
    for t in prog.get("tracks") or []:
        lines.append(f"  Optional {t['kind']}: {t['name']}{' (' + ', '.join(t['codes']) + ')' if t.get('codes') else ''}{'. ' + t['note'] if t.get('note') else ''}")
    for n in prog.get("notes") or []:
        lines.append(f"  Note: {n}")
    return lines


def course_data_text(index: dict, programs: list[dict]) -> str:
    lines = ["COURSE DATA", f"Catalog source: {index['source']}",
             f"Semester for sections: {index['semester']}{' (term code ' + index['termCode'] + ')' if index['termCode'] else ''}"]
    lines.append("SECTIONS ARE SAMPLE DATA: CRNs, times, rooms, seats, and instructor names are made up for the demo. Say this when you mention them."
                 if index["sample"] else
                 "Sections were imported from the live IIT Course Status Report through Pop. Seats may have changed since import.")
    fc = index["forecast"]
    if fc:
        lines.append(f"Future offerings: {fc['source']} Terms covered: {', '.join(t['label'] for t in fc['terms'])}. "
                     '"futureTerms" lists the terms a course is expected; an empty list means not planned in those terms. Always call this tentative.')
    lines.append("One JSON object per course:")
    grad_stubs = [c for c in index["list"] if c.get("stub") and c["level"] >= 500]
    for c in index["list"]:
        if c.get("stub") and c["level"] >= 500:
            continue
        row: dict[str, Any] = {"code": c["code"], "title": c["title"], "credits": c["credits"], "department": c["department"]}
        if c.get("satisfies"):
            row["satisfies"] = c["satisfies"]
        if c.get("bridge"):
            row["graduateBridge"] = True
        if c.get("stub"):
            row["note"] = "Not in the app catalog file. Only section data is known."
        row["description"] = c["description"]
        row["prereqText"] = c.get("prereqText") or "None"
        row["prereq"] = c.get("prereq")
        if c.get("note"):
            row["note"] = c["note"]
        row["unlocks"] = [d["code"] + ("*" if d["concurrent"] else "") for d in c["dependents"]]
        row["sections"] = [compact_section(s) for s in c["sections"]]
        if c.get("futureTerms") is not None:
            row["futureTerms"] = c["futureTerms"]
        if c.get("forecastNote"):
            row["forecastNote"] = c["forecastNote"]
        lines.append(_js(row))
    if grad_stubs:
        names = "; ".join(f"{c['code']}{' ' + c['title'] if c['title'] else ''}" for c in grad_stubs)
        lines.append(f"Graduate and professional courses with sections in {index['semester']} (not in the catalog file; ask the student to search the app for times): {names}.")
    if fc:
        labels = {t["key"]: t["label"] for t in fc["terms"]}
        only = [(code, keys) for code, keys in fc["courses"].items() if code not in index["courses"]]
        if only:
            lines.append("Courses on the future-offerings forecast that are not in this catalog (graduate and CSP courses; titles and prerequisites unknown unless noted):")
            notes = fc.get("notes") or {}
            lines.append("; ".join(
                f"{code}{' (' + notes[code] + ')' if notes.get(code) else ''}: {', '.join(labels.get(k) or '' for k in keys) if keys else 'not planned'}"
                for code, keys in only))
    if programs:
        lines.extend(program_lines(programs[0]))
    if len(programs) > 1:
        lines.append("Other undergraduate programs in the app (requirement details are added to STUDENT CONTEXT for the student's own program): "
                     + "; ".join(f"{p['name']} ({p['totalCredits']} cr)" for p in programs[1:]) + ".")
    ext = sorted(index["external"].keys())
    if ext:
        lines.append(f"Course codes named in prerequisites but not in this catalog (details unknown): {', '.join(ext)}")
    return "\n".join(lines)


def course_data_from_db(conn: sqlite3.Connection) -> tuple[str, dict]:
    catalog = catalog_json(conn)
    sections = sections_json(conn)
    forecast = forecast_json(conn)
    programs = programs_json(conn)["programs"]
    index = build_index(catalog, sections, forecast)
    return course_data_text(index, programs), index
