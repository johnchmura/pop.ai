"""Tests for the advisor built on Pop: data from SQLite, COURSE DATA, and the web API.

Run: python -m unittest tests.test_advisor -v
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"

# every test run gets its own database
_TMP = tempfile.TemporaryDirectory()
os.environ["POP_DB_PATH"] = str(Path(_TMP.name) / "advisor-test.db")

from app.advisor.catalog import (  # noqa: E402
    build_index,
    catalog_json,
    compact_section,
    course_data_text,
    forecast_json,
    programs_json,
    sections_json,
)
from app.advisor.prereq import clean_prereq_text, parse_prereq  # noqa: E402
from app.advisor.store import get_value, open_db, seed  # noqa: E402


class PrereqParserTests(unittest.TestCase):
    def test_same_trees_as_the_javascript_parser(self):
        cases = json.loads((FIXTURES / "prereq_cases.json").read_text(encoding="utf-8"))
        self.assertGreater(len(cases), 1000)
        for case in cases:
            self.assertEqual(parse_prereq(case["t"]), case.get("tree"), case["t"])

    def test_examples(self):
        self.assertIsNone(parse_prereq(""))
        self.assertEqual(parse_prereq("Junior standing."), {"type": "text", "text": "Junior standing"})
        self.assertEqual(
            parse_prereq("CS 116 with min. grade of C* or CS 201"),
            {"type": "or", "children": [
                {"type": "course", "code": "CS 116", "minGrade": "C", "concurrent": True},
                {"type": "course", "code": "CS 201"},
            ]},
        )
        # "and" binds tighter than "or"
        tree = parse_prereq("CS 331 and CS 350 or CS 401")
        self.assertEqual(tree["type"], "or")
        self.assertEqual(tree["children"][0]["type"], "and")
        self.assertEqual(clean_prereq_text("CS 116* or CS 201*, An asterisk (*) designates a course which may be taken concurrently."),
                         "CS 116* or CS 201*")


class DataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = open_db()
        cls.counts = seed(cls.conn)

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def test_seed_loads_into_pops_tables(self):
        self.assertEqual(self.counts["programs"], 50)
        self.assertGreater(self.counts["catalog"], 1000)
        n = self.conn.execute("SELECT COUNT(*) FROM catalog_courses").fetchone()[0]
        self.assertEqual(n, self.counts["catalog"])
        self.assertEqual(get_value(self.conn, "semester"), "Spring 2027")

    def test_catalog_has_trees_fixes_and_flags(self):
        cat = catalog_json(self.conn)
        by = {c["code"]: c for c in cat["courses"]}
        self.assertIn("CS 331", by)
        self.assertEqual(by["CS 331"]["prereq"]["type"], "or")
        # hand-checked tree: the catalog text for CS 450 has no parentheses
        self.assertIn("note", by["CS 450"])
        self.assertTrue(by["CS 401"].get("bridge"))
        # graduate courses only when a program or the forecast names them
        self.assertTrue(all(int(c["code"].split()[1]) < 500 or c["code"] in ("CS 512", "CS 522", "CS 577", "CS 578", "CS 581", "CS 583", "CS 584", "CS 585", "MATH 569", "MATH 574") for c in cat["courses"]))
        self.assertEqual(cat["departments"]["CS"], "Computer Science")

    def test_fix_applies_only_while_the_catalog_wording_is_the_same(self):
        fixes = get_value(self.conn, "prereq_fixes")
        code = next(c for c, f in fixes.items() if "prereq" in f and "forText" in f and f["forText"])
        before = {c["code"]: c for c in catalog_json(self.conn)["courses"]}[code]["prereq"]
        self.assertEqual(before, fixes[code]["prereq"])
        self.conn.execute("UPDATE catalog_courses SET prerequisites = ? WHERE code = ?", ("MATH 151", code))
        try:
            after = {c["code"]: c for c in catalog_json(self.conn)["courses"]}[code]["prereq"]
            self.assertEqual(after, {"type": "course", "code": "MATH 151"})
        finally:
            self.conn.execute("UPDATE catalog_courses SET prerequisites = ? WHERE code = ?", (fixes[code]["forText"], code))

    def test_sections_are_pops_export(self):
        sec = sections_json(self.conn)
        self.assertEqual(sec["semester_name"], "Spring 2027")
        self.assertFalse(sec["sample"])
        self.assertGreater(len(sec["courses"]), 500)
        first = sec["courses"][0]
        self.assertIn("Spring 2027", first["sections"])

    def test_index_merges_rows_with_the_same_crn(self):
        offerings = {"semester_name": "Spring 2027", "courses": [{"name": "ARCH 202", "title": "Studio", "sections": {"Spring 2027": {"Class": [
            {"crn": "21896", "schedule_type": "STU", "available": "3", "meetings": [{"days": "W", "time": "4 PM - 5:50 PM", "where": "Crown", "instructors": ["A B"]}]},
            {"crn": "21896", "schedule_type": "STU", "available": "3", "meetings": [{"days": "MF", "time": "1:50 PM - 5:50 PM", "where": "Crown", "instructors": ["A B"]}]},
        ]}}}]}
        idx = build_index({"courses": [], "departments": {}}, offerings, None)
        s = idx["crnMap"]["21896"]
        self.assertEqual([m["days"] for m in s["meetings"]], ["W", "MF"])
        self.assertEqual(s["scheduleType"], "Studio")
        self.assertEqual(compact_section(s), "CRN 21896 Studio: W 4 PM - 5:50 PM, Crown, A B / MF 1:50 PM - 5:50 PM, Crown, A B; 3 seats open")

    def test_course_data_matches_the_page_code(self):
        """COURSE DATA from Python must equal the JavaScript version (web/js/core/context.js)."""
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        cat, sec, fc, prog = catalog_json(self.conn), sections_json(self.conn), forecast_json(self.conn), programs_json(self.conn)
        py = course_data_text(build_index(cat, sec, fc), prog["programs"])
        with tempfile.TemporaryDirectory() as d:
            for name, obj in (("catalog", cat), ("sections", sec), ("forecast", fc), ("programs", prog)):
                Path(d, f"{name}.json").write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
            script = (
                "import { readFileSync } from 'node:fs';"
                f"import {{ buildIndex }} from '{(ROOT / 'web/js/core/catalog.js').as_uri()}';"
                f"import {{ courseDataBlock }} from '{(ROOT / 'web/js/core/context.js').as_uri()}';"
                "const j = (n) => JSON.parse(readFileSync(process.argv[1] + '/' + n + '.json', 'utf8'));"
                "process.stdout.write(courseDataBlock(buildIndex(j('catalog'), j('sections'), j('forecast')), j('programs').programs));"
            )
            js = subprocess.run([node, "--input-type=module", "-e", script, d], capture_output=True, text=True, check=True, encoding="utf-8").stdout
        self.assertEqual(len(py), len(js))
        self.assertEqual(py, js)


# ---------------------------------------------------------------- API


class FakeClaude(BaseHTTPRequestHandler):
    """Stands in for the Claude Messages API."""

    requests: list = []
    status = 200

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        FakeClaude.requests.append({"headers": dict(self.headers), "body": body})
        if FakeClaude.status != 200:
            out = json.dumps({"error": {"type": "x", "message": "nope"}}).encode()
            self.send_response(FakeClaude.status)
            self.send_header("content-length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return
        if body.get("stream"):
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            for evt in (
                {"type": "message_start", "message": {"usage": {}}},
                {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello "}},
                {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "student."}},
                {"type": "message_delta", "delta": {"stop_reason": "max_tokens"}},
            ):
                self.wfile.write(f"event: e\r\ndata: {json.dumps(evt)}\r\n\r\n".encode())
            return
        if isinstance(body.get("system"), str):
            text = '```json\n{"courses":[{"code":"CS 115","credits":2,"grade":"A","status":"completed"},"junk"],"warnings":["w"],"majors":["Computer Science"]}\n```'
        else:
            text = '{"summary":"ok","terms":[]}'
        out = json.dumps({"content": [{"type": "text", "text": text}], "stop_reason": "end_turn"}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeClaude)
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()
        from fastapi.testclient import TestClient

        import app.advisor.server as server

        cls.server = server
        cls.client = TestClient(server.app)
        cls.client.__enter__()  # runs startup: loads data from the database

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)
        cls.upstream.shutdown()

    def setUp(self):
        FakeClaude.requests.clear()
        FakeClaude.status = 200
        self.server._hits.clear()
        cfg = self.server.config
        self.patch = mock.patch.multiple(cfg, api_key="test-key", base_url=f"http://127.0.0.1:{self.upstream.server_port}", rate_limit=30)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()

    def test_page_data_and_health(self):
        r = self.client.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("advisor.", r.text)
        self.assertEqual(r.headers["x-frame-options"], "DENY")
        h = self.client.get("/api/health").json()
        self.assertEqual(h["mode"], "claude")
        self.assertEqual(h["semester"], "Spring 2027")
        self.assertFalse(h["sampleSections"])
        self.assertIn("bs-cs", h["programs"])
        for name in ("catalog", "sections", "forecast", "programs"):
            self.assertEqual(self.client.get(f"/data/{name}.json").status_code, 200)
        cat = self.client.get("/data/catalog.json").json()
        self.assertGreater(len(cat["courses"]), 1000)

    def test_nothing_outside_web_is_served(self):
        for path in ("/data/nope.json", "/.env", "/main.py", "/../main.py", "/%2e%2e/main.py", "/js/../../main.py", "/seed/catalog.json", "/api/nope"):
            self.assertEqual(self.client.get(path).status_code, 404, path)

    def test_chat_streams_and_sends_course_data_and_student_context(self):
        r = self.client.post("/api/chat", json={"messages": [{"role": "assistant", "content": "hi"}, {"role": "user", "content": "What next?"}],
                                                "studentContext": "STUDENT CONTEXT\nCompleted: CS 331"})
        self.assertEqual(r.status_code, 200)
        events = [json.loads(line[5:]) for line in r.text.split("\n") if line.startswith("data:")]
        self.assertEqual(events[0]["type"], "meta")
        self.assertEqual("".join(e["text"] for e in events if e["type"] == "text"), "Hello student.\n\n_(Answer cut short. Ask me to continue.)_")
        self.assertEqual(events[-1]["type"], "done")
        sent = FakeClaude.requests[0]
        self.assertEqual(sent["headers"]["x-api-key"], "test-key")
        system = sent["body"]["system"]
        self.assertTrue(system[1]["text"].startswith("COURSE DATA"))
        self.assertEqual(system[1]["cache_control"], {"type": "ephemeral"})
        self.assertEqual(system[2]["text"], "STUDENT CONTEXT\nCompleted: CS 331")
        self.assertEqual(sent["body"]["messages"], [{"role": "user", "content": "What next?"}])  # starts with the student

    def test_chat_errors(self):
        self.assertEqual(self.client.post("/api/chat", json={"messages": []}).status_code, 400)
        self.assertEqual(self.client.post("/api/chat", content=b"not json", headers={"content-type": "application/json"}).status_code, 400)
        FakeClaude.status = 401
        r = self.client.post("/api/chat", json={"messages": [{"role": "user", "content": "hi"}]})
        events = [json.loads(line[5:]) for line in r.text.split("\n") if line.startswith("data:")]
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("key was rejected", events[-1]["message"])

    def test_offline_mode(self):
        with mock.patch.object(self.server.config, "api_key", ""):
            r = self.client.post("/api/chat", json={"messages": [{"role": "user", "content": "hi"}]})
            self.assertEqual(r.status_code, 503)
            self.assertEqual(r.json()["mode"], "offline")
            self.assertEqual(self.client.get("/api/health").json()["mode"], "offline")
            self.assertEqual(self.client.post("/api/plan", json={"studentContext": "x"}).status_code, 503)

    def test_plan(self):
        r = self.client.post("/api/plan", json={"studentContext": "STUDENT CONTEXT\nPLAN TASK", "userText": "Make my plan."})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["text"], '{"summary":"ok","terms":[]}')
        sent = FakeClaude.requests[0]["body"]
        self.assertEqual(sent["max_tokens"], 8000)
        self.assertEqual(sent["system"][2]["text"], "STUDENT CONTEXT\nPLAN TASK")
        self.assertEqual(self.client.post("/api/plan", json={"nope": 1}).status_code, 400)

    def test_transcript(self):
        r = self.client.post("/api/transcript", json={"text": "CS 115 A"})
        self.assertEqual(r.status_code, 200)
        out = r.json()
        self.assertEqual(out["courses"], [{"code": "CS 115", "credits": 2, "grade": "A", "status": "completed"}])
        self.assertEqual(out["majors"], ["Computer Science"])
        self.assertIsInstance(FakeClaude.requests[0]["body"]["system"], str)
        self.assertEqual(self.client.post("/api/transcript", json={"file": {"mediaType": "text/x-sh", "data": "AAAA"}}).status_code, 400)
        self.assertEqual(self.client.post("/api/transcript", json={"file": {"mediaType": "image/png", "data": "<script>"}}).status_code, 400)
        self.assertEqual(self.client.post("/api/transcript", json={}).status_code, 400)

    def test_rate_limit(self):
        with mock.patch.object(self.server.config, "rate_limit", 2):
            codes = [self.client.post("/api/plan", json={"nope": 1}).status_code for _ in range(3)]
        self.assertEqual(codes, [400, 400, 429])

    def test_semantic_search(self):
        with mock.patch.object(self.server, "semantic_available", lambda: False):
            self.assertEqual(self.client.post("/api/search/semantic", json={"query": "robots"}).status_code, 503)
        fake_api = mock.MagicMock()
        fake_api.embed_query.return_value = [0.0] * 384
        from app.data_models import SemanticHit

        hits = [SemanticHit(course_name="CS 484", title="Machine Learning", score=0.91234)]
        with mock.patch.object(self.server, "semantic_available", lambda: True), \
                mock.patch.dict(sys.modules, {"app.api": fake_api}), \
                mock.patch("app.db.semantic_search", return_value=hits):
            r = self.client.post("/api/search/semantic", json={"query": "learning from data"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["results"], [{"code": "CS 484", "title": "Machine Learning", "score": 0.9123}])

    def test_clean_messages(self):
        clean = self.server.clean_messages
        self.assertEqual(clean("x"), [])
        msgs = clean([{"role": "assistant", "content": "a"}, {"role": "user", "content": " q1 "}, {"role": "user", "content": "q2"},
                      {"role": "system", "content": "no"}, {"role": "assistant", "content": "ans"}])
        self.assertEqual(msgs, [{"role": "user", "content": "q1\n\nq2"}])



class NoSqliteExtensionTests(unittest.TestCase):
    def test_works_when_python_cannot_load_sqlite_extensions(self):
        import app.db as db

        path = Path(_TMP.name) / "no-vec.db"
        with mock.patch.object(db.sqlite_vec, "load", side_effect=AttributeError("no enable_load_extension")):
            conn = open_db(path)
            counts = seed(conn)
            self.assertGreater(counts["catalog"], 1000)
            self.assertGreater(len(catalog_json(conn)["courses"]), 1000)
            self.assertEqual(sections_json(conn)["semester_name"], "Spring 2027")
            conn.close()



FACULTY = [
    {"name": "Ada Lovelace", "profile_url": "https://www.iit.edu/directory/people/ada-lovelace", "titles": ["Associate Professor of Computer Science"],
     "departments": ["Computer Science"], "profile_types": ["Faculty"], "email": "ada@illinoistech.edu",
     "research_interests": ["Machine Learning", "Natural Language Processing"], "publications": ["Deep models for text (2024)"],
     "google_scholar_url": "https://scholar.google.com/citations?user=x"},
    {"name": "Grace Hopper", "profile_url": "https://www.iit.edu/directory/people/grace-hopper", "titles": ["Professor"],
     "departments": ["Computer Science"], "email": "not-an-email", "research_interests": ["Compilers", "Programming Languages"],
     "additional_sections": {"Areas of Expertise": ["Robotics"], "Professional Activities": ["Machine learning committee"]}},
    {"name": "Marie Curie", "profile_url": "https://www.iit.edu/directory/people/marie-curie", "titles": ["Professor of Physics"],
     "departments": ["Physics"], "email": "curie@illinoistech.edu", "research_interests": ["Radioactivity", "Learning sciences"]},
    {"name": "", "profile_url": "https://www.iit.edu/directory/people/nobody"},
    {"name": "Elsewhere", "profile_url": "https://evil.example.com/x"},
]


class FacultyTests(unittest.TestCase):
    def setUp(self):
        from app.advisor.faculty import FacultyIndex

        self.index = FacultyIndex(FACULTY)

    def test_records_are_cleaned(self):
        names = [r["name"] for r in self.index.records]
        self.assertEqual(names, ["Ada Lovelace", "Grace Hopper", "Marie Curie"])  # no name / not iit.edu dropped
        grace = self.index.records[1]
        self.assertEqual(grace["email"], "")  # not an email
        self.assertIn("Robotics", grace["research_interests"])  # from "Areas of Expertise"
        self.assertNotIn("Machine learning committee", grace["research_interests"])
        self.assertEqual(grace["slug"], "grace-hopper")

    def test_search_ranks_research_matches_first(self):
        hits = self.index.search("machine learning")
        self.assertEqual(hits[0]["name"], "Ada Lovelace")
        self.assertEqual(hits[0]["matched"], ["Machine Learning"])
        self.assertEqual([h["name"] for h in self.index.search("robots")], ["Grace Hopper"])  # plural matches
        self.assertEqual(self.index.search("learning", dept="Physics")[0]["name"], "Marie Curie")
        self.assertEqual(self.index.search("who does research"), [])  # only filler words
        self.assertEqual(self.index.departments, ["Computer Science", "Physics"])

    def test_chat_block_only_for_research_questions(self):
        from app.advisor.faculty import faculty_block

        self.assertEqual(faculty_block(self.index, "Can I take CS 331 next term?"), "")
        block = faculty_block(self.index, "Which professors do research in machine learning?", "2026-10-29")
        self.assertTrue(block.startswith("FACULTY MATCHES (IIT's online directory, read 2026-10-29"))
        self.assertIn("1. Ada Lovelace", block)
        self.assertIn("Email: ada@illinoistech.edu", block)
        self.assertIn("Profile: https://www.iit.edu/directory/people/ada-lovelace", block)
        none = faculty_block(self.index, "Who does research on underwater basket weaving?")
        self.assertIn("no faculty matched", none)

    def test_api_and_chat_use_faculty(self):
        from fastapi.testclient import TestClient

        import app.advisor.server as server
        from app.advisor.faculty import FacultyIndex

        with TestClient(server.app) as client, mock.patch.object(server.data, "faculty", FacultyIndex(FACULTY)):
            r = client.get("/api/faculty", params={"q": "natural language", "limit": 5})
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()["results"][0]["name"], "Ada Lovelace")
            self.assertEqual(client.get("/api/faculty/departments").json()["departments"], ["Computer Science", "Physics"])
            blocks = server.system_blocks("STUDENT CONTEXT", "Who should I do machine learning research with?")
            self.assertEqual(len(blocks), 4)
            self.assertIn("Ada Lovelace", blocks[3]["text"])
            self.assertEqual(len(server.system_blocks("STUDENT CONTEXT", "When is CS 331 offered?")), 3)
        with mock.patch.object(server.data, "faculty", None):
            self.assertEqual(TestClient(server.app).get("/api/faculty", params={"q": "x"}).status_code, 503)


class RefreshTests(unittest.TestCase):
    """The cron job's scrapers and checks, on real IIT pages saved in tests/fixtures (no network)."""

    @classmethod
    def setUpClass(cls):
        import gzip

        cls.rows = json.loads((FIXTURES / "csr_rows_cs.json").read_text(encoding="utf-8"))
        with gzip.open(FIXTURES / "iit_directory_pages.json.gz", "rt", encoding="utf-8") as f:
            cls.pages = json.load(f)

    def seed_copy(self, courses=None):
        """A temporary seed/ with advisor.json, faculty.json and (some of) the Spring 2027 sections."""
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        for name in ("advisor.json", "faculty.json"):
            shutil.copy(ROOT / "seed" / name, tmp / name)
        payload = json.loads((ROOT / "seed" / "spring_2027.json").read_text(encoding="utf-8"))
        if courses is not None:
            payload["courses"] = [c for c in payload["courses"] if courses(c)]
        (tmp / "spring_2027.json").write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        return tmp

    def test_sections_rebuild_the_seed_exactly(self):
        from app.advisor import refresh

        seed_dir = self.seed_copy(lambda c: c["name"].startswith("CS "))
        before = (seed_dir / "spring_2027.json").read_text(encoding="utf-8")
        code = refresh.run(faculty="no", seed_dir=seed_dir, fetch_rows=lambda term: self.rows)
        self.assertEqual(code, 0)
        self.assertEqual((seed_dir / "spring_2027.json").read_text(encoding="utf-8"), before)  # same rows, same file

        changed = [dict(r) for r in self.rows]
        changed[0]["available"] = 0
        refresh.run(faculty="no", seed_dir=seed_dir, fetch_rows=lambda term: changed)
        self.assertNotEqual((seed_dir / "spring_2027.json").read_text(encoding="utf-8"), before)

    def test_small_or_failed_scrapes_keep_the_seed(self):
        from app.advisor import refresh

        seed_dir = self.seed_copy()  # all 882 courses; the CS rows alone are far fewer
        before = (seed_dir / "spring_2027.json").read_text(encoding="utf-8")
        self.assertEqual(refresh.run(faculty="no", seed_dir=seed_dir, fetch_rows=lambda term: self.rows), 1)

        def broken(term):
            raise RuntimeError("403")

        self.assertEqual(refresh.run(faculty="no", seed_dir=seed_dir, fetch_rows=broken), 1)
        self.assertEqual((seed_dir / "spring_2027.json").read_text(encoding="utf-8"), before)

    def test_profiles_parse_like_the_seed(self):
        from app.advisor.faculty import clean_record
        from app.advisor.refresh import parse_profile

        seeded = {r["slug"]: r for r in json.loads((ROOT / "seed" / "faculty.json").read_text(encoding="utf-8"))["faculty"]}
        for slug in ("sumanta-acharya", "bernhard-adams", "hamid-arastoopour"):
            url = f"https://www.iit.edu/directory/people/{slug}"
            got = clean_record(parse_profile(url, self.pages[f"profile_{slug}.html"]))
            want = dict(seeded[slug])
            if slug == "hamid-arastoopour":  # each title is now its own entry
                self.assertEqual(" ".join(got["titles"]), want["titles"][0])
                got["titles"] = want["titles"]
            self.assertEqual(got, want)
        acharya = clean_record(parse_profile("https://www.iit.edu/directory/people/sumanta-acharya",
                                             self.pages["profile_sumanta-acharya.html"]))
        self.assertTrue(acharya["research_interests"] and acharya["google_scholar_url"])

    def test_directory_paging(self):
        from app.advisor import refresh

        urls, more = refresh.directory_links(self.pages["directory_page0.html"])
        self.assertTrue(more)
        self.assertEqual(urls[0], "https://www.iit.edu/directory/people/naser-abas")
        self.assertEqual(len(urls), len(set(urls)))
        self.assertEqual(refresh.directory_links(self.pages["directory_last.html"])[1], False)

        def get(url):
            if url.endswith("?profile_type=21"):
                return self.pages["directory_page0.html"]
            if url.endswith("&page=1"):
                return self.pages["directory_last.html"]
            return self.pages["profile_bernhard-adams.html"]

        payload = refresh.refresh_faculty(get, pause=0)
        self.assertEqual(len(payload["faculty"]), len(urls) + 1)
        self.assertRegex(payload["read_on"], r"^\d{4}-\d{2}-\d{2}$")

    def test_faculty_age(self):
        import datetime as dt

        from app.advisor import refresh

        seed_dir = self.seed_copy()
        read_on = dt.date.fromisoformat(json.loads((seed_dir / "faculty.json").read_text(encoding="utf-8"))["read_on"])
        self.assertFalse(refresh.faculty_is_stale(seed_dir, read_on + dt.timedelta(days=20)))
        self.assertTrue(refresh.faculty_is_stale(seed_dir, read_on + dt.timedelta(days=21)))
        (seed_dir / "faculty.json").unlink()
        self.assertTrue(refresh.faculty_is_stale(seed_dir))

    def test_push_commits_only_seed_changes(self):
        from app.advisor import refresh

        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        git = lambda *a, cwd=tmp: subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True, text=True).stdout
        git("init", "-q", "--bare", "-b", "master", "remote.git")
        git("init", "-q", "-b", "master", "work")
        (tmp / "work" / "seed").mkdir()
        (tmp / "work" / "seed" / "faculty.json").write_text("{}\n")
        git("add", ".", cwd=tmp / "work")
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "start", cwd=tmp / "work")
        git("push", "-q", str(tmp / "remote.git"), "master", cwd=tmp / "work")

        new = tmp / "faculty.json"
        new.write_text('{"faculty": []}\n')
        env = {"GITHUB_TOKEN": "secret-token", "DATA_REPO": "owner/repo", "DATA_BRANCH": "master"}
        with mock.patch.dict(os.environ, env), mock.patch.object(refresh, "remote_url", lambda t, r: str(tmp / "remote.git")):
            self.assertTrue(refresh.push_seed([new], "Refresh data from IIT: test"))
            self.assertFalse(refresh.push_seed([new], "again"))  # nothing new
        log = git("--git-dir", str(tmp / "remote.git"), "log", "--format=%an|%s", "master")
        self.assertEqual(log.splitlines()[0], "pop-advisor data bot|Refresh data from IIT: test")
        with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "", "DATA_REPO": "owner/repo"}):
            with self.assertRaises(RuntimeError):
                refresh.push_seed([new], "x")


if __name__ == "__main__":
    unittest.main()
