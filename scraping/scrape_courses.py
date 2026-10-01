'''
Scrapes the Course Status Report for times, professors, etc. Writes semester
offerings into SQLite only. Descriptions are joined from catalog_courses at
export/index time (run.sh / write_semester_files).

Usage:
    python scrape_courses.py <semester> <year> [-s <subject1> <subject2> ...]

    Example:
        python scrape_courses.py fall 2024 -s CS MATH

Defaults to all subjects if none are specified.
'''

import argparse
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from data_models import Offering  # noqa: E402
from db import (  # noqa: E402
    empty_str,
    replace_semester_courses,
    upsert_semester,
)

ALL_SUBJECTS = [
    {"subjectCode":"AAH","subjectDesc":"Art and Architectural History"},
    {"subjectCode":"ARCH","subjectDesc":"Architecture"},
    {"subjectCode":"AS","subjectDesc":"Air Force Aerospace Studies"},
    {"subjectCode":"AURB","subjectDesc":"Architecture and Urbanism"},
    {"subjectCode":"BANL","subjectDesc":"Business Analytics"},
    {"subjectCode":"BIOL","subjectDesc":"Biology"},
    {"subjectCode":"BME","subjectDesc":"Biomedical Engineering"},
    {"subjectCode":"BRVN","subjectDesc":"Braven"},
    {"subjectCode":"BUS","subjectDesc":"Business"},
    {"subjectCode":"CAE","subjectDesc":"Civil and Architectural Engr"},
    {"subjectCode":"CAPS","subjectDesc":"Comm for Acad and Prof Success"},
    {"subjectCode":"CHE","subjectDesc":"Chemical Engineering"},
    {"subjectCode":"CHEM","subjectDesc":"Chemistry"},
    {"subjectCode":"COM","subjectDesc":"Communications"},
    {"subjectCode":"COOP","subjectDesc":"Cooperative Education"},
    {"subjectCode":"CS","subjectDesc":"Computer Science"},
    {"subjectCode":"CSP","subjectDesc":"Computer Science Prof Master"},
    {"subjectCode":"DS","subjectDesc":"Data Science"},
    {"subjectCode":"ECE","subjectDesc":"Electrical and Computer Engr"},
    {"subjectCode":"ECON","subjectDesc":"Economics"},
    {"subjectCode":"EMGT","subjectDesc":"Engineering Management"},
    {"subjectCode":"ENGR","subjectDesc":"General Engineering"},
    {"subjectCode":"ENVE","subjectDesc":"Environmental Engineering"},
    {"subjectCode":"EXCH","subjectDesc":"Exchange Student"},
    {"subjectCode":"FDSN","subjectDesc":"Food Science and Nutrition"},
    {"subjectCode":"GCS","subjectDesc":"Graduate Continuation Studies"},
    {"subjectCode":"GEM","subjectDesc":"Game Design & Experiential Mgm"},
    {"subjectCode":"HIST","subjectDesc":"History"},
    {"subjectCode":"HUM","subjectDesc":"Humanities"},
    {"subjectCode":"ID","subjectDesc":"Institute of Design"},
    {"subjectCode":"IDN","subjectDesc":"Institute of Design"},
    {"subjectCode":"IDX","subjectDesc":"Institute of Design"},
    {"subjectCode":"IEP","subjectDesc":"Intensive English Program"},
    {"subjectCode":"INTM","subjectDesc":"Industrial Tech and Mgmt"},
    {"subjectCode":"INTR","subjectDesc":"Internship"},
    {"subjectCode":"IPRO","subjectDesc":"Interprofessional Project"},
    {"subjectCode":"ITM","subjectDesc":"Information Tech and Mgmt"},
    {"subjectCode":"ITMD","subjectDesc":"ITM Development"},
    {"subjectCode":"ITMM","subjectDesc":"ITM Management"},
    {"subjectCode":"ITMO","subjectDesc":"ITM Operations"},
    {"subjectCode":"ITMS","subjectDesc":"ITM Security"},
    {"subjectCode":"ITMT","subjectDesc":"ITM Theory and Technology"},
    {"subjectCode":"LA","subjectDesc":"Landscape Architecture"},
    {"subjectCode":"LAW","subjectDesc":"Law"},
    {"subjectCode":"LCS","subjectDesc":"Law Continuation Studies"},
    {"subjectCode":"LIT","subjectDesc":"Literature"},
    {"subjectCode":"MATH","subjectDesc":"Mathematics"},
    {"subjectCode":"MAX","subjectDesc":"Marketing Analytics"},
    {"subjectCode":"MBA","subjectDesc":"MBA Business"},
    {"subjectCode":"MILS","subjectDesc":"Military Science"},
    {"subjectCode":"MMAE","subjectDesc":"Mechl, Mtrls and Arspc Engrg"},
    {"subjectCode":"MS","subjectDesc":"Materials Science"},
    {"subjectCode":"MSC","subjectDesc":"Management Science"},
    {"subjectCode":"MSF","subjectDesc":"Master of Science in Finance"},
    {"subjectCode":"NS","subjectDesc":"Naval Science"},
    {"subjectCode":"PA","subjectDesc":"Public Administration"},
    {"subjectCode":"PD","subjectDesc":"Professional Development"},
    {"subjectCode":"PHIL","subjectDesc":"Philosophy"},
    {"subjectCode":"PHYS","subjectDesc":"Physics"},
    {"subjectCode":"PM","subjectDesc":"Project Management"},
    {"subjectCode":"PS","subjectDesc":"Political Science"},
    {"subjectCode":"PSYC","subjectDesc":"Psychology"},
    {"subjectCode":"SAM","subjectDesc":" Sustainability Analytics & Ma"},
    {"subjectCode":"SOC","subjectDesc":"Sociology"},
    {"subjectCode":"SSB","subjectDesc":"Stuart School of Business"},
    {"subjectCode":"SSCI","subjectDesc":"Social Sciences"},
    {"subjectCode":"STAT","subjectDesc":"Statistics"},
    {"subjectCode":"STDA","subjectDesc":"Study Abroad"},
    {"subjectCode":"TASI","subjectDesc":"Technology & Social Innovation"},
    {"subjectCode":"TECH","subjectDesc":"Technology"},
    {"subjectCode":"UCS","subjectDesc":"Undergrad Continuing Studies"}
]

def get_term_code(semester, year):
    semester = semester.lower()
    if semester == 'fall':
        return f"{year + 1}10"
    elif semester == 'spring':
        return f"{year}20"
    elif semester == 'summer':
        return f"{year}30"
    else:
        raise ValueError("Invalid semester")

SCHEDULE_TYPES = {
    "LEC": "Lecture",
    "LAB": "Lab",
    "IND": "Independent Study/Research",
    "AC": "Accelerated Course",
    "B": "Lecture/Lab",
    "REC": "Recitation/Discussion",
}

def format_time(time_str):
    """Converts '1125 - 1240' to '11:25 AM - 12:40 PM'"""
    time_str = empty_str(time_str)
    if not time_str:
        return ""
    if "TBA" in time_str.upper():
        return "TBA"

    parts = [p.strip() for p in time_str.split("-")]
    formatted_parts = []
    
    for part in parts:
        if len(part) == 4 and part.isdigit():
            hour = int(part[:2])
            minute = part[2:]
            period = "PM" if hour >= 12 else "AM"
            display_hour = hour
            if hour > 12:
                display_hour = hour - 12
            elif hour == 0:
                display_hour = 12
            if minute == "00":
                formatted_parts.append(f"{display_hour} {period}")
            else:
                formatted_parts.append(f"{display_hour}:{minute} {period}")
        else:
            formatted_parts.append(part)
            
    return " - ".join(formatted_parts)

def main():
    parser = argparse.ArgumentParser(
        description="Fetch Course Status Report into SQLite offerings."
    )
    parser.add_argument("semester", choices=["spring", "summer", "fall"], type=str.lower)
    parser.add_argument("year", type=int)
    parser.add_argument("-s", "--subjects", nargs="+", help="Specific subject codes to fetch")

    args = parser.parse_args()

    term_code = get_term_code(args.semester, args.year)
    semester_name = f"{args.semester.capitalize()} {args.year}"

    if args.subjects:
        target_codes = [s.upper() for s in args.subjects]
        selected_subjects = [sub for sub in ALL_SUBJECTS if sub["subjectCode"] in target_codes]
        if not selected_subjects:
            print(f"Error: None of the subjects {target_codes} were found.")
            sys.exit(1)
    else:
        selected_subjects = ALL_SUBJECTS

    url = "https://wildfly-prd.iit.edu/coursestatusreport/api/report/getCSR"
    payload = {
        "selectedTerm": term_code,
        "selectedSubjectsForTerm": selected_subjects
    }

    print(f"Fetching data for {semester_name}...")
    response = requests.post(url, json=payload)

    if response.status_code != 200:
        print(f"Request failed: {response.status_code}\n{response.text}")
        sys.exit(1)

    raw_csr_data = response.json()

    if not isinstance(raw_csr_data, list):
        print("Error: API did not return a list of rows as expected.")
        sys.exit(1)

    print("Formatting times and grouping sections")

    courses_map = {}

    for row in raw_csr_data:
        subj = row.get("courseSubject", "")
        num = row.get("courseNumber", "")
        course_name = f"{subj} {num}".strip()

        if not course_name:
            continue

        if course_name not in courses_map:
            courses_map[course_name] = {
                "name": course_name,
                "title": row.get("courseTitle", "Unknown Title"),
                "sections": {},
            }

        if semester_name not in courses_map[course_name]["sections"]:
            courses_map[course_name]["sections"][semester_name] = {}

        code = empty_str(row.get("courseType"))
        schedule_type = SCHEDULE_TYPES.get(code, code)
        bucket = "Internet" if "internet" in empty_str(row.get("campus")).lower() else "Class"
        if bucket not in courses_map[course_name]["sections"][semester_name]:
            courses_map[course_name]["sections"][semester_name][bucket] = []

        raw = empty_str(row.get("instructor"))
        if "," in raw:
            last, first = raw.split(",", 1)
            raw = first.strip() + " " + last.strip()
        instructors_list = [raw] if raw else []

        days = empty_str(row.get("days"))
        time = format_time(row.get("time"))
        where = empty_str(row.get("locations"))
        if not where and (days or (time and time != "TBA")):
            where = "TBA"

        row_title = empty_str(row.get("courseTitle"))
        parent_title = courses_map[course_name]["title"]
        special_title = row_title if row_title and row_title != parent_title else ""

        available = row.get("available")
        if available is None:
            available = ""

        section_obj = {
            "crn": row.get("departmentCode", ""),
            "schedule_type": schedule_type,
            "type": bucket,
            "available": available,
            "special_title": special_title,
            "meetings": [
                {
                    "days": days,
                    "time": time,
                    "where": where,
                    "instructors": instructors_list,
                    "dates": empty_str(row.get("dates"))
                }
            ]
        }

        merged_section = {**row, **section_obj}
        courses_map[course_name]["sections"][semester_name][bucket].append(merged_section)

    offerings = [Offering.model_validate(course) for course in courses_map.values()]
    print(f"Compiled into {len(offerings)} unique courses.")

    semester_id = upsert_semester(
        args.semester.lower(),
        args.year,
        term_code=term_code,
        label=semester_name,
    )
    db_count = replace_semester_courses(semester_id, offerings)
    print(f"Upserted {db_count} offerings for {semester_name} into SQLite.")
    print("Run ./run.sh to export Pop JS and reindex embeddings.")


if __name__ == "__main__":
    main()
