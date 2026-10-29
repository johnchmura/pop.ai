# advisor. on Pop

A course advisor for Illinois Tech, built on [Pop](https://github.com/johnchmura/pop.ai). Pop's Python server, SQLite database, and scrapers are the foundation. The advisor adds a degree audit, semester plans with suggested courses, a prerequisite graph, a weekly schedule, transcript upload, and a Claude chat advisor.

## Quick start

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-advisor.txt
cp .env.example .env            # add ANTHROPIC_API_KEY for Claude chat (optional)
python main.py advisor-seed     # load seed/ into data/pop.db (first time)
python main.py advisor-serve    # http://localhost:3000
```

Without an API key the app still works: chat answers come from the app's own data.

## How it is built

| Part | Where | What it does |
|---|---|---|
| Database | `data/pop.db` (Pop's SQLite) | Pop's tables hold the catalog (`catalog_courses`) and sections (`semesters`, `courses`). The advisor adds one table, `advisor_data`, for degree programs, the CS forecast, department names, and hand-checked prerequisite fixes. |
| Scrapers | `scraping/` (Pop) | Fill the database from catalog.iit.edu and IIT's Course Status Report. |
| Server | `app/advisor/` (FastAPI) | Builds `/data/*.json` from the database, adds COURSE DATA to Claude requests, streams chat, reads transcripts with Claude, and serves the page. |
| Page | `web/` | The advisor's interface and logic: search, schedule, graph, degree audit, plans, suggestions, settings, mobile layout. |
| Seed data | `seed/` | The advisor's checked catalog, 50 degree programs, forecast, and real Spring 2027 sections, so a new checkout works without scraping. |

Server routes: `GET /api/health`, `GET /data/{catalog,sections,forecast,programs}.json`, `POST /api/chat` (server-sent events), `POST /api/plan`, `POST /api/transcript`, `POST /api/search/semantic`.

The page builds each student's context (transcript, saved sections, degree progress) and sends it with the question. The server adds COURSE DATA from the database, so the full course list never leaves the server.

## Real data from Pop

Pop's scrapers write straight into the database the advisor reads. Restart the server after scraping.

```bash
python scraping/scrape_courses.py spring 2027      # real sections, times, rooms, seats
python scraping/scrape_descriptions.py             # the full catalog (replaces the seed catalog)
python main.py advisor-serve
```

The semester the schedule and plans use is set in `seed/advisor.json` (`"semester"`). Prerequisite fixes in `advisor_data` apply only while the catalog wording is the same, so new wording from the scraper wins.

To change degree programs or the forecast, edit `seed/programs.json` or `seed/forecast.json`, then run `python main.py advisor-seed --keep-catalog --keep-sections`.

### Search by meaning

Pop's semantic search works in the advisor's search box ("Search by meaning") when Pop's model is installed and the semester is indexed:

```bash
pip install -r requirements.txt
python main.py index spring 2027
```

## Tests

```bash
python -m unittest tests.test_advisor tests.test_db -v   # server, data, parser, COURSE DATA parity
node --test web/test/*.test.mjs                           # page logic (search, audit, planner, suggestions, ...)
```

## Deploy on Render

`render.yaml` deploys the advisor: New → Blueprint, pick the repo, paste `ANTHROPIC_API_KEY`. The build loads `seed/` into a fresh database.

## Notes

- `scripts/seed_from_node_advisor.py` made `seed/` from the earlier Node version of the advisor.
- A full catalog scrape makes COURSE DATA longer (full descriptions for every subject). The server prints a warning if it gets very long.
- Not an official Illinois Tech service. Confirm plans with your academic advisor.

---

# Pop.ai

Search Illinois Tech courses in the browser: one search box, a cart, and a schedule.

This started as [Soda](http://madebyevan.com/soda/app/) by [Evan Wallace](https://github.com/evanw/) at Brown. [Eric Tendian](https://tendian.io/) adapted it for Illinois Tech as Pop; this repo is a fork of [clarifyeducation/pop](https://github.com/clarifyeducation/pop). This fork will enhance this great project with AI elements to further help the students at IIT.

## Files

- [src/](src/) - client app; `python main.py build` concatenates into `www/soda.js`.
- [www/](www/) - static UI and templates.
- [app/](app/) - FastAPI API, Pydantic models, SQLite + sqlite-vec (`data/pop.db`).
- [main.py](main.py) - CLI: `build`, `serve`, `index`, `import-data`.
- [scraping/](scraping/) - course and catalog scrapers.
- [run.sh](run.sh) - index if needed, export Pop JS, start API + static server.
- [requirements.txt](requirements.txt) - Python deps.

## Run to Setup
```bash
git clone https://github.com/johnchmura/pop.ai.git

python -m venv .venv
source .venv/bin/activate

pip install -r requirements.txt
python scraping/scrape_descriptions.py
python scraping/scrape_courses.py fall 2026
./run.sh fall 2026
```

Open http://localhost:8000/fall2026.html

Shift+Enter runs semantic search (API on :8001). `run.sh` needs `envsubst` (`sudo apt install gettext-base` if missing).

After changing embedding text logic, reindex so vectors match:

```bash
./run.sh fall 2026 --reindex
```

Optional clean DB (drops leftover unused columns like old `meta_json`):

```bash
rm data/pop.db
python scraping/scrape_descriptions.py
python scraping/scrape_courses.py fall 2026
./run.sh fall 2026 --reindex
```

```bash
python main.py build
python main.py serve
python main.py index fall 2026
python main.py import-data --all-semesters
```

## Tests
```bash
python -m unittest discover -s tests -v
```
