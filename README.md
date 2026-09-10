# Soda

Currently hosted at: http://madebyevan.com/soda/app/

Soda is a replacement course browser for Brown University. The system at Brown is called Banner and has a terrible search interface. There is essentially a widget for every field in the course database. Besides being cumbersome, the system is also slow and mistakes cost the user time as the request bounces back from the server. This delay is especially bad around the start of the semester when all students at Brown are using the system to schedule their courses.

Soda fixes all this. The entire list of current courses is downloaded to the browser once at page load time, after which the entire app runs client-side. While this is a higher initial load, the common usage pattern is relatively long periods of scheduling where a client-side app like Soda actually saves in data transfer. In addition, the entire list of courses can be gzipped and cached by the browser, so the actual data transfer overhead isn't bad at all.

Searches are performed instantly as the user types. There is only one search textbox, which can search titles, departments, professors, buildings, and other metadata and contains some extra smarts to pick out common course abbreviations in use around the campus. There are several shortcomings however: Soda currently has no way of scraping textbook info, and Soda may be slightly out of date since its data represents a snapshot of Banner in the past.

## Installation

To get Pop up and running with the current IIT course feed:

1. Generate the site data and semester pages:

    ```bash
    python scrape.py site
    ```

    If you only want one term, pass a term code or term name:

    ```bash
    python scrape.py site --term 202710
    ```

2. Build the browser bundle:

    ```bash
    python build.py release
    ```

3. Start the local server:

    ```bash
    python server.py
    ```

Then open http://localhost:8000/ in your browser. The generated site files live under `www/` and the semester-specific course data is written to `www/data/`.

Note: the current IIT feed does not expose Banner-style CRNs, so the scraper generates stable synthetic section IDs for browsing and cart state.
