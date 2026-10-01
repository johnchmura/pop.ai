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
