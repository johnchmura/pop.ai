# Pop.ai

Search Illinois Tech courses in the browser: one search box, a cart, and a schedule.

This started as [Soda](http://madebyevan.com/soda/app/) by [Evan Wallace](https://github.com/evanw/) at Brown. [Eric Tendian](https://tendian.io/) adapted it for Illinois Tech as Pop; this repo is a fork of [clarifyeducation/pop](https://github.com/clarifyeducation/pop). This fork will enhance this great project with AI elements to further help the students at IIT.

## Files

- [src/](src/) - client app (`search.js`, `cart.js`, `schedule.js`, `options.js`, `main.js`, `semantic.js`). [build.py](build.py) concatenates these into `www/soda.js`.
- [www/](www/) - static UI (`style.css` and templates). [www/semester.html.tpl](www/semester.html.tpl) is the search page (`$SEMESTER_NAME`, `$SEMESTER_DATA`).
- [data_models.py](data_models.py) - Pydantic models (`CatalogCourse`, `Semester`, `Offering`, `PopCourse`, `SemanticHit`, `EmbeddingRow`).
- [db.py](db.py) - SQLite source of truth (`data/pop.db`): catalog, semester offerings, sqlite-vec embeddings.
- [scraping/scrape_courses.py](scraping/scrape_courses.py) - Course Status Report into SQLite offerings.
- [scraping/scrape_descriptions.py](scraping/scrape_descriptions.py) - bulletin catalog into SQLite (run rarely).
- [index_semester.py](index_semester.py) - embed a semester into sqlite-vec.
- [api.py](api.py) - FastAPI semantic search on port 8001 (`/health`, `/search/semantic`).
- [server.py](server.py) - serves `www/` on port 8000.
- [run.sh](run.sh) - indexes if needed, exports Pop JS from SQLite, starts API + static server.
- [import_data.py](import_data.py) - one-shot import of legacy `www/data` JSON into SQLite.
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

Shift+Enter runs semantic search (API on :8001). `run.sh` regenerates the Pop JS cache from SQLite and needs `envsubst` (`sudo apt install gettext-base` if missing).

## Tests
```bash
python -m unittest discover -s tests -v
```
