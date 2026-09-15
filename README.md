# Pop.ai

Search Illinois Tech courses in the browser: one search box, a cart, and a schedule.

This started as [Soda](http://madebyevan.com/soda/app/) by [Evan Wallace](https://github.com/evanw/) at Brown. [Eric Tendian](https://tendian.io/) adapted it for Illinois Tech as Pop; this repo is a fork of [clarifyeducation/pop](https://github.com/clarifyeducation/pop). This fork will enhance this great project with AI elements to further help the students at IIT.

## Files

- [src/](src/) - client app (`search.js`, `cart.js`, `schedule.js`, `options.js`, `main.js`). [build.py](build.py) concatenates these into `www/soda.js`.
- [www/](www/) - static UI (`style.css` and templates). [www/semester.html.tpl](www/semester.html.tpl) is the search page (`$SEMESTER_NAME`, `$SEMESTER_DATA`). [www/index.html.tpl](www/index.html.tpl) is the landing page.
- [scraping/scrape_courses.py](scraping/scrape_courses.py) - Course Status Report dump to `www/data/<semester>_<year>.js`.
- [scraping/scrape_descriptions.py](scraping/scrape_descriptions.py) - bulletin catalog to `www/data/full_catalog.json` (run rarely).
- [server.py](server.py) - serves `www/` on port 8000.
- [run.sh](run.sh) - sets `SEMESTER_NAME` / `SEMESTER_DATA`, runs `build.py`, writes the semester HTML, starts the server.
- [update-site.sh](update-site.sh) - builds every semester page and uploads to S3.
- [requirements.txt](requirements.txt) - Python deps. [Dockerfile](Dockerfile) - deploy image.

## Run to Setup
```bash
git clone https://github.com/johnchmura/pop.ai.git

#setup venv
python -m venv .venv
source .venv/bin/activate

pip install -r requirements.txt
python scraping/scrape_descriptions.py
python scraping/scrape_courses.py fall 2026
./run.sh fall 2026
```

Open http://localhost:8000/fall2026.html

`run.sh` needs `envsubst` (`sudo apt install gettext-base` if it is missing). Skip the descriptions scrape if `www/data/full_catalog.json` already exists.
