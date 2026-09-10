import argparse
import hashlib
import json
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE_URL = "https://wildfly-prd.iit.edu/coursestatusreport/api/report"
ROOT = Path(__file__).resolve().parent
WWW_DIR = ROOT / "www"


def slugify_term(term_name):
    return "".join(char.lower() for char in term_name if char.isalnum())


def academic_year(term_name):
    parts = term_name.split()
    season = parts[0] if parts else ""
    year = next((part for part in parts if part.isdigit() and len(part) == 4), None)
    if year is None:
        return None
    start_year = int(year) if season == "Fall" else int(year) - 1
    return f"{start_year}-{start_year + 1}"


def section_type_label(course_type):
    course_type = course_type or ""
    labels = {
        "LEC": "Class",
        "LAB": "Lab",
        "SEM": "Seminar",
        "DIS": "Discussion",
        "IND": "Independent Study",
    }
    return labels.get(course_type, course_type.title())


def stable_section_id(term_code, course_code):
    digest = hashlib.sha1(f"{term_code}:{course_code}".encode()).hexdigest()
    return int(digest[:12], 16) % 9000000 + 1000000


def format_time_value(value):
    if not value:
        return value
    value = value.strip()
    if value.lower() == "tba":
        return value
    digits = "".join(character for character in value if character.isdigit())
    if len(digits) != 4:
        return value

    hours = int(digits[:2])
    minutes = digits[2:]
    suffix = "am"
    if hours == 0:
        hours = 12
    elif hours == 12:
        suffix = "pm"
    elif hours > 12:
        hours -= 12
        suffix = "pm"

    return f"{hours}:{minutes}{suffix}"


def format_time_range(value):
    if not value:
        return value
    parts = [part.strip() for part in value.split("-")]
    if len(parts) != 2:
        return format_time_value(value)
    return " - ".join(format_time_value(part) for part in parts)


def request_json(path, data=None):
    body = json.dumps(data).encode() if data is not None else None
    request = Request(
        f"{BASE_URL}/{path}",
        data=body,
        headers={"Content-Type": "application/json"} if body else {},
    )

    try:
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except (HTTPError, URLError, TimeoutError) as error:
        raise RuntimeError(f"Course Status Report request failed: {error}") from error


def get_terms():
    return request_json("getAllTerms")["allTerms"]


def get_subjects(term):
    return request_json(f"getSubjects/?{urlencode({'term': term})}")


def get_courses(term, subjects):
    return request_json("getCSR", {
        "selectedTerm": term,
        "selectedSubjectsForTerm": [
            {"subjectCode": subject.upper()} for subject in subjects
        ],
    })


def build_course_data(term):
    term_code = term["termCode"]
    term_name = term["termDesc"]
    subjects = [subject["subjectCode"] for subject in get_subjects(term_code)]
    rows = get_courses(term_code, subjects)

    return {
        "term_code": term_code,
        "term_name": term_name,
        "rows": [
            {
                "providedCrn": row.get("departmentCode", ""),
                "departmentCode": row.get("departmentCode", ""),
                "courseCode": row.get("courseCode", ""),
                "courseType": row.get("courseType", ""),
                "days": row.get("days", ""),
                "time": row.get("time", ""),
                "locations": row.get("locations", ""),
                "status": row.get("status", ""),
                "courseSubject": row.get("courseSubject", ""),
                "courseNumber": row.get("courseNumber", ""),
                "courseTitle": row.get("courseTitle", ""),
                "credits": row.get("credits", ""),
                "max": row.get("max", ""),
                "enrolled": row.get("enrolled", ""),
                "available": row.get("available", ""),
                "campus": row.get("campus", ""),
                "instructor": row.get("instructor", ""),
                "waitCount": row.get("waitCount", ""),
                "department": row.get("department", ""),
                "college": row.get("college", ""),
                "crossListCode": row.get("crossListCode"),
            }
            for row in rows
        ],
    }


def write_term_data(term, output_dir):
    data = build_course_data(term)
    output_path = output_dir / f"{term['termCode']}.js"
    text = "var popScrapeData = " + json.dumps(data, indent=2)
    text += ";\n"
    output_path.write_text(text, encoding="utf-8")
    return output_path


def render_index(terms):
    year_items = {}
    year_order = []

    for term in terms:
        term_name = term["termDesc"]
        term_file = f"{slugify_term(term_name)}.html"
        year = academic_year(term_name)
        if year is None:
            continue

        if year not in year_items:
            year_items[year] = []
            year_order.append(year)
        year_items[year].append(
            f'                <li><a href="{term_file}">Search {term_name} Courses using Pop 1.0</a></li>'
        )

    semester_groups = []
    for year in year_order:
        semester_groups.append('        <section class="school-year">')
        semester_groups.append(f"            <h2>{year} School Year</h2>")
        semester_groups.append("            <ul>")
        semester_groups.extend(year_items[year])
        semester_groups.append("            </ul>")
        semester_groups.append("        </section>")

    template = (WWW_DIR / "index.html.tpl").read_text(encoding="utf-8")
    return template.replace("$SEMESTER_GROUPS", "\n".join(semester_groups) + "\n")


def render_semester_page(term_name, data_file):
    template = (WWW_DIR / "semester.html.tpl").read_text(encoding="utf-8")
    return template.replace("$SEMESTER_NAME", term_name).replace("$SEMESTER_DATA", f"data/{data_file.name}")


def build_site(term_filters=None, output_dir=WWW_DIR):
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    data_dir = output_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    terms = get_terms()
    if term_filters:
        wanted = {term.lower() for term in term_filters}
        terms = [term for term in terms if term["termCode"].lower() in wanted or term["termDesc"].lower() in wanted]

    written_pages = []
    for term in terms:
        data_path = write_term_data(term, data_dir)
        semester_page = output_dir / f"{slugify_term(term['termDesc'])}.html"
        semester_page.write_text(render_semester_page(term["termDesc"], data_path), encoding="utf-8")
        written_pages.append(semester_page)

    (output_dir / "index.html").write_text(render_index(terms), encoding="utf-8")
    return data_dir, written_pages


def main():
    parser = argparse.ArgumentParser(description="Scrape IIT's Course Status Report")
    output = argparse.ArgumentParser(add_help=False)
    output.add_argument("-o", "--output", help="Write JSON to this file")
    site = argparse.ArgumentParser(add_help=False)
    site.add_argument("--output-dir", default=str(WWW_DIR), help="Write generated site files here")
    site.add_argument("--term", action="append", dest="terms", help="Only build matching term code or term name")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("terms", parents=[output], help="List available terms")

    subjects = subparsers.add_parser(
        "subjects", parents=[output], help="List subjects for a term"
    )
    subjects.add_argument("term")

    courses = subparsers.add_parser(
        "courses", parents=[output], help="List courses for a term and subjects"
    )
    courses.add_argument("term")
    courses.add_argument("subjects", nargs="+")

    subparsers.add_parser(
        "site", parents=[site], help="Generate www/index.html, semester pages, and data files"
    )

    args = parser.parse_args()

    if args.command == "terms":
        result = get_terms()
    elif args.command == "subjects":
        result = get_subjects(args.term)
    elif args.command == "courses":
        result = get_courses(args.term, args.subjects)
    else:
        data_dir, pages = build_site(args.terms, args.output_dir)
        print(f"Wrote {data_dir}")
        for page in pages:
            print(f"Wrote {page}")
        print(f"Wrote {Path(args.output_dir) / 'index.html'}")
        return

    text = json.dumps(result, indent=2)
    if args.output:
        with open(args.output, "w") as output:
            output.write(text + "\n")
    else:
        print(text)


if __name__ == "__main__":
    main()
