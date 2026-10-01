import json
import re
import tempfile
import unittest
from pathlib import Path

from data_models import CatalogCourse, PopCourse, Semester
from db import (
    catalog_attributes,
    catalog_count,
    connect,
    embedding_count,
    export_semester_payload,
    init_db,
    list_semesters,
    load_semester_courses,
    normalize_code,
    replace_semester_courses,
    upsert_catalog_courses,
    upsert_semester,
    write_semester_files,
)


class DbTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmpdir.name) / "test.db"
        self.conn = init_db(connect(self.db_path))

    def tearDown(self):
        self.conn.close()
        self._tmpdir.cleanup()

    def test_normalize_code(self):
        self.assertEqual(normalize_code("  cs   430 "), "CS 430")

    def test_catalog_and_semester_join(self):
        upsert_catalog_courses(
            [
                CatalogCourse(
                    code="CS 430",
                    title="Introduction to Algorithms",
                    description="Analysis of algorithms.",
                    credits="3",
                    lecture="3",
                    lab="0",
                    prerequisites="CS 331",
                )
            ],
            conn=self.conn,
        )
        self.assertEqual(catalog_count(self.conn), 1)

        semester_id = upsert_semester(
            "fall",
            2026,
            term_code="202710",
            label="Fall 2026",
            conn=self.conn,
        )
        replace_semester_courses(
            semester_id,
            [
                {
                    "name": "CS 430",
                    "title": "Introduction to Algorithms",
                    "sections": {
                        "Fall 2026": {
                            "Class": [
                                {
                                    "crn": "12345",
                                    "schedule_type": "Lecture",
                                    "meetings": [],
                                }
                            ]
                        }
                    },
                }
            ],
            conn=self.conn,
        )

        semester, courses = load_semester_courses(
            season="fall",
            year=2026,
            conn=self.conn,
        )
        self.assertIsInstance(semester, Semester)
        self.assertEqual(semester.label, "Fall 2026")
        self.assertEqual(len(courses), 1)
        course = courses[0]
        self.assertIsInstance(course, PopCourse)
        self.assertEqual(course.name, "CS 430")
        self.assertIn("Analysis of algorithms", course.description)
        self.assertIn("Credits: 3", course.attributes)
        self.assertIn("Prerequisite(s): CS 331", course.attributes)
        self.assertIn("Class", course.sections["Fall 2026"])

        payload = export_semester_payload("fall", 2026, conn=self.conn)
        self.assertEqual(payload["term_code"], "202710")
        self.assertEqual(len(payload["courses"]), 1)

        listed = list_semesters(conn=self.conn)
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0].course_count, 1)

    def test_course_without_catalog_has_empty_description(self):
        semester_id = upsert_semester("fall", 2026, conn=self.conn)
        replace_semester_courses(
            semester_id,
            [
                {
                    "name": "CS 999",
                    "title": "Special Topics",
                    "sections": {"Class": [{"crn": "9", "meetings": []}]},
                }
            ],
            conn=self.conn,
        )
        _, courses = load_semester_courses(season="fall", year=2026, conn=self.conn)
        self.assertEqual(courses[0].description, "")
        self.assertEqual(courses[0].attributes, "")

    def test_semester_isolation(self):
        fall_id = upsert_semester("fall", 2026, conn=self.conn)
        spring_id = upsert_semester("spring", 2026, conn=self.conn)
        replace_semester_courses(
            fall_id,
            [{"name": "CS 115", "title": "Object-Oriented Programming I", "sections": {}}],
            conn=self.conn,
        )
        replace_semester_courses(
            spring_id,
            [{"name": "MATH 151", "title": "Calculus I", "sections": {}}],
            conn=self.conn,
        )
        _, fall_courses = load_semester_courses(season="fall", year=2026, conn=self.conn)
        _, spring_courses = load_semester_courses(
            season="spring", year=2026, conn=self.conn
        )
        self.assertEqual([c.name for c in fall_courses], ["CS 115"])
        self.assertEqual([c.name for c in spring_courses], ["MATH 151"])

    def test_write_semester_files_pop_shape(self):
        upsert_catalog_courses(
            [
                CatalogCourse(
                    code="CS 430",
                    title="Introduction to Algorithms",
                    description="Analysis of algorithms.",
                    credits="3",
                    lecture="3",
                    lab="0",
                    prerequisites="CS 331",
                )
            ],
            conn=self.conn,
        )
        semester_id = upsert_semester(
            "fall", 2026, term_code="202710", conn=self.conn
        )
        replace_semester_courses(
            semester_id,
            [
                {
                    "name": "CS 430",
                    "title": "Introduction to Algorithms",
                    "sections": {
                        "Class": [
                            {
                                "crn": "12345",
                                "schedule_type": "Lecture",
                                "meetings": [],
                            }
                        ]
                    },
                }
            ],
            conn=self.conn,
        )
        data_dir = Path(self._tmpdir.name) / "data"
        js_path, json_path = write_semester_files(
            "fall", 2026, data_dir=data_dir, conn=self.conn
        )
        self.assertTrue(js_path.exists())
        self.assertTrue(json_path.exists())

        js_text = js_path.read_text(encoding="utf-8")
        self.assertIn('var semesters = ["Fall 2026"]', js_text)
        self.assertIn("var courses =", js_text)
        match = re.search(r"var courses = (\[.*\]);?\s*$", js_text, re.S)
        self.assertIsNotNone(match)
        courses = json.loads(match.group(1))
        self.assertEqual(len(courses), 1)
        course = courses[0]
        self.assertEqual(course["name"], "CS 430")
        self.assertIn("description", course)
        self.assertIn("attributes", course)
        self.assertIn("Analysis of algorithms", course["description"])
        self.assertEqual(
            course["sections"]["Fall 2026"]["Class"][0]["crn"],
            "12345",
        )

        payload = json.loads(json_path.read_text(encoding="utf-8"))
        self.assertEqual(payload["semester_name"], "Fall 2026")
        self.assertEqual(len(payload["courses"]), 1)

    def test_catalog_attributes(self):
        attrs = catalog_attributes(
            CatalogCourse(code="CS 430", credits="3", lecture="3", prerequisites="CS 331")
        )
        self.assertEqual(
            attrs,
            "Credits: 3. Lecture: 3. Prerequisite(s): CS 331.",
        )

    def test_replace_keeps_bucket_shape(self):
        semester_id = upsert_semester("spring", 2025, conn=self.conn)
        replace_semester_courses(
            semester_id,
            [
                {
                    "name": "MATH 151",
                    "title": "Calculus I",
                    "sections": {"Class": [{"crn": "1", "meetings": []}]},
                }
            ],
            conn=self.conn,
        )
        row = self.conn.execute(
            "SELECT sections_json FROM courses WHERE course_name = ?",
            ("MATH 151",),
        ).fetchone()
        buckets = json.loads(row["sections_json"])
        self.assertIn("Class", buckets)
        self.assertIsInstance(buckets["Class"], list)

    def test_embedding_count_empty(self):
        self.assertEqual(embedding_count(conn=self.conn), 0)
        upsert_semester("fall", 2026, conn=self.conn)
        self.assertEqual(
            embedding_count(season="fall", year=2026, conn=self.conn),
            0,
        )


if __name__ == "__main__":
    unittest.main()
