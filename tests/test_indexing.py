import unittest

from app.api import build_embedding_text
from app.data_models import PopCourse


SAMPLE_COURSE = PopCourse(
    name="CS 430",
    title="Introduction to Algorithms",
    description="Analysis of algorithms and data structures.",
    attributes=(
        "Credits: 3. Lecture: 3. Lab: 0. "
        "Prerequisite(s): CS 331. "
        "Corequisite(s): None. "
        "Satisfies: None."
    ),
    sections={
        "Fall 2026": {
            "Class": [
                {
                    "crn": "12345",
                    "schedule_type": "Lecture",
                    "special_title": "Advanced Topics",
                    "available": "5",
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
                    "meetings": [],
                }
            ],
        }
    },
)


class IndexingTests(unittest.TestCase):
    def test_build_embedding_text(self):
        text = build_embedding_text(SAMPLE_COURSE)
        self.assertIn("Course: CS 430 — Introduction to Algorithms", text)
        self.assertIn("Subject: CS", text)
        self.assertIn("Attributes: Credits: 3", text)
        self.assertIn("Prerequisite(s): CS 331", text)
        self.assertIn("Description: Analysis of algorithms", text)
        self.assertIn("Section topics: Advanced Topics", text)
        self.assertIn("Formats offered: Lecture", text)
        self.assertIn("Delivery: Class, Internet", text)

    def test_description_missing(self):
        course = SAMPLE_COURSE.model_copy(update={"description": ""})
        self.assertIn("Description: None", build_embedding_text(course))


if __name__ == "__main__":
    unittest.main()
