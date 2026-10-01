import unittest

from index_semester import (
    build_embedding_text,
    parse_attributes,
    subject_label,
)


SAMPLE_COURSE = {
    "name": "CS 430",
    "title": "Introduction to Algorithms",
    "description": "Analysis of algorithms and data structures.",
    "attributes": (
        "Credits: 3. Lecture: 3. Lab: 0. "
        "Prerequisite(s): CS 331. "
        "Corequisite(s): None. "
        "Satisfies: None."
    ),
    "sections": {
        "Fall 2026": {
            "Class": [
                {
                    "crn": "12345",
                    "schedule_type": "Lecture",
                    "special_title": "Advanced Topics",
                    "available": "5",
                    "campus": "Mies",
                    "meetings": [
                        {
                            "days": "MW",
                            "time": "11:25 AM - 12:40 PM",
                            "instructors": ["Jane Smith"],
                        }
                    ],
                }
            ],
            "Internet": [
                {
                    "crn": "12346",
                    "schedule_type": "Lecture",
                    "special_title": "",
                    "available": "0",
                    "campus": "Internet",
                    "meetings": [],
                }
            ],
        }
    },
}


class IndexingTests(unittest.TestCase):
    def test_subject_label(self):
        self.assertEqual(subject_label("CS 430"), "Computer Science")

    def test_parse_attributes(self):
        parsed = parse_attributes(SAMPLE_COURSE["attributes"])
        self.assertEqual(parsed["credits"], "3")
        self.assertEqual(parsed["prerequisites"], "CS 331")

    def test_build_embedding_text(self):
        text = build_embedding_text(SAMPLE_COURSE)
        self.assertIn("Course: CS 430 — Introduction to Algorithms", text)
        self.assertIn("Subject: Computer Science", text)
        self.assertIn("Description: Analysis of algorithms", text)
        self.assertIn("Prerequisites: CS 331", text)
        self.assertIn("Section topics: Advanced Topics", text)
        self.assertIn("Formats offered: Lecture", text)
        self.assertIn("Delivery: Class, Internet", text)

    def test_description_missing(self):
        course = dict(SAMPLE_COURSE)
        course["description"] = ""
        self.assertIn("Description: None", build_embedding_text(course))


if __name__ == "__main__":
    unittest.main()
