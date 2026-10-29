# Pop.ai

Search Illinois Tech courses, build a schedule, and plan your degree with an AI advisor.

This started as [Soda](http://madebyevan.com/soda/app/) by [Evan Wallace](https://github.com/evanw/) at Brown. [Eric Tendian](https://tendian.io/) adapted it for Illinois Tech as Pop; this repo is a fork of [clarifyeducation/pop](https://github.com/clarifyeducation/pop). This fork adds AI to help IIT students: semantic search, and **advisor.**, a course advisor built on Pop's data.

## Two apps, one database

Both apps read the same SQLite database (`data/pop.db`), filled by Pop's scrapers.

| App | What it does | Start | Open |
|---|---|---|---|
| **advisor.** | Search, weekly schedule, prerequisite graph, degree audit from a transcript, semester plans with suggested courses, Claude chat advisor (also finds research faculty). Works on phones. | `python main.py advisor-serve` | http://localhost:3000 |
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

## Faculty search

The chat helps students find faculty whose research fits their interests. Ask about research, labs, or professors ("Who does machine learning research?"). The server adds the best-matching faculty to Claude's context, so the advisor names real people, links their profiles, and suggests the courses that prepare for their work. Without an API key, the offline answer lists the matching faculty.

The data comes from IIT's online directory (iit.edu/directory/people), read the way Ishaan Goel's [iit-faculty-search](https://github.com/igoeldc/iit-faculty-search) scraper reads it. `seed/faculty.json` holds a copy, and the daily refresh job (see Deploy) updates it weekly. To refresh it now:

```bash
python main.py advisor-refresh --no-sections --faculty yes
```

Restart the advisor afterwards. Search is keyword-based (BM25, research interests and names count most) and needs no extra libraries.

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
| `app/advisor/` | The advisor's server (FastAPI): data from the database, Claude chat, plans, transcript reading, faculty search, and the data refresh (`refresh.py`). |
| `web/` | The advisor's page and its logic (search, schedule, graph, audit, planner, suggestions). |
| `seed/` | Seed data for the advisor, including `faculty.json`. `advisor.json` sets the schedule semester (`"semester"`). |
| `advisor_instructions.txt` | The advisor's system prompt. Edits apply without a restart. |
| `src/`, `www/` | The Pop page. `python main.py build` joins `src/*.js` into `www/soda.js`. |
| `main.py` | CLI: `build`, `serve`, `index`, `import-data`, `advisor-seed`, `advisor-faculty`, `advisor-refresh`, `advisor-serve`. |
| `run.sh` | Starts the Pop page with semantic search. |

## How the advisor uses Pop's data

- **Catalog and sections:** from Pop's tables (`catalog_courses`, `semesters`, `courses`). Prerequisite text is turned into AND/OR trees for the graph, the audit, and the planner.
- **Advisor data:** one extra table, `advisor_data`, holds the degree programs, the CS forecast, department names, hand-checked prerequisite fixes, and the faculty list. A fix applies only while the catalog wording is the same, so new wording from the scraper wins.
- **Claude:** the page sends the student's own context (transcript, saved sections, progress) with each question. The server adds the course list from the database, plus matching faculty for research questions, and calls Claude. Routes: `GET /api/health`, `GET /data/*.json`, `GET /api/faculty`, `POST /api/chat`, `POST /api/plan`, `POST /api/transcript`, `POST /api/search/semantic`.

To change degree programs or the forecast, edit `seed/programs.json` or `seed/forecast.json`, then run `python main.py advisor-seed --keep-catalog --keep-sections`.

## Tests

```bash
python -m unittest discover -s tests -v                 # all Python tests (needs requirements.txt)
python -m unittest tests.test_advisor tests.test_db -v  # without the machine-learning libraries
node --test web/test/*.test.mjs                         # the advisor page's logic
```

## Deploy

`render.yaml` deploys the advisor on Render: **New → Blueprint**, pick the repo, and paste `ANTHROPIC_API_KEY`. The build loads `seed/` into a new database. The Pop page and semantic search are not deployed.

### Daily data refresh

The web service never scrapes. It uses the data in `seed/`. A Render cron job, `pop-advisor-refresh`, keeps `seed/` fresh:

1. Every day at 9:17 UTC, it reads IIT's Course Status Report for the semester in `seed/advisor.json`.
2. Once a week, it also reads every faculty profile in IIT's directory (about 15 minutes).
3. It commits any changed seed files to GitHub. The push makes Render redeploy the advisor with the new data.

Setup: make a GitHub token that can push to this repository (a fine-grained token with **Contents: Read and write**), and paste it as `GITHUB_TOKEN` when the Blueprint asks. The job pushes to the branch Render deploys. To push somewhere else, set `DATA_REPO` (`owner/repo`) and `DATA_BRANCH`.

Safety checks: if a scrape fails, or returns much less than the current seed (under 60% of the courses or 80% of the faculty), the job keeps the old file and the run shows as failed in Render's logs.

Run it by hand: `python main.py advisor-refresh` updates `seed/` on your computer. Add `--faculty yes` to read the directory now, or `--push` to commit to GitHub.

Notes: Render cron jobs are paid (billed per minute, with a small monthly minimum). The job does not refresh the catalog or degree programs; they change once a year. To move to a new semester, change `"semester"` in `seed/advisor.json`. IIT might block requests from Render's servers; if so, the logs show the error and the site keeps working with the last data.

## Notes

- Not an official Illinois Tech service. Confirm plans with your academic advisor.
- A full catalog scrape adds long descriptions for every subject, so the course list sent to Claude gets longer. The advisor prints a warning at start if it gets too long.
- `scripts/seed_from_node_advisor.py` made `seed/` from the earlier Node version of the advisor ([WillMo2198/advisor](https://github.com/WillMo2198/advisor)).
