# Pop.ai

Search Illinois Tech courses, build a schedule, and plan your degree with an AI advisor.

This started as [Soda](http://madebyevan.com/soda/app/) by [Evan Wallace](https://github.com/evanw/) at Brown. [Eric Tendian](https://tendian.io/) adapted it for Illinois Tech as Pop; this repo is a fork of [clarifyeducation/pop](https://github.com/clarifyeducation/pop). This fork adds AI to help IIT students: semantic search, and **advisor.**, a course advisor built on Pop's data.

## Two apps, one database

Both apps read the same SQLite database (`data/pop.db`), filled by Pop's scrapers.

| App | What it does | Start | Open |
|---|---|---|---|
| **advisor.** | Search, weekly schedule, prerequisite graph, degree audit from a transcript, semester plans with suggested courses, Claude chat advisor. Works on phones. | `python main.py advisor-serve` | http://localhost:3000 |
| **Pop search page** | The classic Pop page: one search box, a cart, and a schedule. Shift+Enter runs semantic search. | `./run.sh spring 2027` | http://localhost:8000/spring2027.html |

## Setup

```bash
git clone https://github.com/johnchmura/pop.ai.git
cd pop.ai
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt     # everything, including semantic search
cp .env.example .env                # add ANTHROPIC_API_KEY for Claude chat (optional)
```

For the advisor only, `pip install -r requirements-advisor.txt` is enough. It skips the large machine-learning libraries, so semantic search is off.

## Get the data

Pick one:

- **Seed data (quick, no scraping):** `python main.py advisor-seed`. Loads the checked catalog, 50 degree programs, the CS forecast, and real Spring 2027 sections from `seed/`.
- **Scrape IIT with Pop:**
  ```bash
  python scraping/scrape_descriptions.py        # the full catalog
  python scraping/scrape_courses.py spring 2027 # sections, times, rooms, seats
  python main.py advisor-seed --keep-catalog --keep-sections   # adds the advisor's degree data, keeps the scraped data
  ```

Without `--keep-catalog` and `--keep-sections`, `advisor-seed` replaces the catalog and the Spring 2027 sections with the seed copies. Run the scrapers again any time; restart the advisor afterwards.

## Run the advisor

```bash
python main.py advisor-serve        # http://localhost:3000
```

Use `--port 3001` if port 3000 is busy. Without `ANTHROPIC_API_KEY`, the app still works and chat answers come from the app's own data. If the database is empty on the first start, the advisor loads `seed/` by itself.

## Run the Pop search page

```bash
./run.sh spring 2027
```

`run.sh` indexes the semester for semantic search if needed, exports the page data, and starts the semantic API (:8001) and the static server (:8000). It needs `envsubst` (`sudo apt install gettext-base` if missing; on a Mac, `brew install gettext`).

After changing the embedding text logic, reindex so the vectors match: `./run.sh spring 2027 --reindex`.

## Semantic search

Pop's semantic search finds courses by meaning, not exact words. It needs `requirements.txt` and an indexed semester:

```bash
python main.py index spring 2027
```

The Pop page runs it with Shift+Enter. The advisor shows a **Search by meaning** button in its search results once the semester is indexed.

## Files

| Path | What it is |
|---|---|
| `scraping/` | Scrapers for catalog.iit.edu, IIT's Course Status Report, and program pages. |
| `app/db.py`, `app/data_models.py` | SQLite + sqlite-vec storage and models. |
| `app/api.py` | Semantic search API (embeddings). |
| `app/advisor/` | The advisor's server (FastAPI): data from the database, Claude chat, plans, transcript reading. |
| `web/` | The advisor's page and its logic (search, schedule, graph, audit, planner, suggestions). |
| `seed/` | Seed data for the advisor. `advisor.json` sets the schedule semester (`"semester"`). |
| `advisor_instructions.txt` | The advisor's system prompt. Edits apply without a restart. |
| `src/`, `www/` | The Pop page. `python main.py build` joins `src/*.js` into `www/soda.js`. |
| `main.py` | CLI: `build`, `serve`, `index`, `import-data`, `advisor-seed`, `advisor-serve`. |
| `run.sh` | Starts the Pop page with semantic search. |

## How the advisor uses Pop's data

- **Catalog and sections:** from Pop's tables (`catalog_courses`, `semesters`, `courses`). Prerequisite text is turned into AND/OR trees for the graph, the audit, and the planner.
- **Advisor data:** one extra table, `advisor_data`, holds the degree programs, the CS forecast, department names, and hand-checked prerequisite fixes. A fix applies only while the catalog wording is the same, so new wording from the scraper wins.
- **Claude:** the page sends the student's own context (transcript, saved sections, progress) with each question. The server adds the course list from the database and calls Claude. Routes: `GET /api/health`, `GET /data/*.json`, `POST /api/chat`, `POST /api/plan`, `POST /api/transcript`, `POST /api/search/semantic`.

To change degree programs or the forecast, edit `seed/programs.json` or `seed/forecast.json`, then run `python main.py advisor-seed --keep-catalog --keep-sections`.

## Tests

```bash
python -m unittest discover -s tests -v                 # all Python tests (needs requirements.txt)
python -m unittest tests.test_advisor tests.test_db -v  # without the machine-learning libraries
node --test web/test/*.test.mjs                         # the advisor page's logic
```

## Deploy

`render.yaml` deploys the advisor on Render: **New → Blueprint**, pick the repo, and paste `ANTHROPIC_API_KEY`. The build loads `seed/` into a new database. The Pop page and semantic search are not deployed.

## Notes

- Not an official Illinois Tech service. Confirm plans with your academic advisor.
- A full catalog scrape adds long descriptions for every subject, so the course list sent to Claude gets longer. The advisor prints a warning at start if it gets too long.
- `scripts/seed_from_node_advisor.py` made `seed/` from the earlier Node version of the advisor ([WillMo2198/advisor](https://github.com/WillMo2198/advisor)).
