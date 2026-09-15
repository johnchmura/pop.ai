'''
Scrapes the banner for all courses and their descriptions. It is ALL possible courses so no need to keep
running this. The other script auto-joins the catalog data with this huge haul on course ids.
'''

import json
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "www" / "data"
CATALOG_PATH = DATA_DIR / "full_catalog.json"

def main():
    print("Step 1: Fetching all course shorthands...")
    index_url = "https://catalog.iit.edu/courses/"
    response = requests.get(index_url)
    soup = BeautifulSoup(response.text, "html.parser")

    course_container = soup.find("div", id="atozindex")
    links = course_container.find_all("a")

    shorthands = []
    for link in links:
        text = link.text
        if "(" in text and ")" in text:
            # Extract the course shorthand used in the fetch
            code = text.split("(")[1].replace(")", "").strip()
            shorthands.append(code)

    print(f"Found {len(shorthands)} subjects to scrape.\n")
    all_courses = []

    print("Step 2: Scraping individual subject pages...")
    # Loop through the shorthands we just collected
    for subject_code in shorthands:
        subject_url = f"https://catalog.iit.edu/courses/{subject_code.lower()}/"
        print(f" -> Fetching {subject_code} from {subject_url}")
        
        subject_response = requests.get(subject_url)
        
        if subject_response.status_code != 200:
            print(f"Failed to load {subject_code}. Status: {subject_response.status_code}")
            continue
            
        subject_soup = BeautifulSoup(subject_response.text, "html.parser")
        course_blocks = subject_soup.find_all("div", class_="courseblock")
        
        for block in course_blocks:
            course_data = {
                "code": "",
                "title": "",
                "description": "",
                "credits": "",
                "lecture": "",
                "lab": "",
                "prerequisites": "",
                "corequisites": "",
                "satisfies": ""
            }
            
            code_tag = block.find("div", class_="coursecode")
            if code_tag:
                course_data["code"] = code_tag.text.strip()
                
            title_tag = block.find("div", class_="coursetitle")
            if title_tag:
                course_data["title"] = title_tag.text.strip()
                
            desc_tag = block.find("div", class_="courseblockdesc")
            if desc_tag:
                course_data["description"] = desc_tag.text.strip()
                
            attributes = block.find_all("div", class_="courseblockattr")
            for attr in attributes:
                if "hours" in attr.get("class", []):
                    spans = attr.find_all("span")
                    for span in spans:
                        text = span.text.strip()
                        if "Lecture:" in text:
                            course_data["lecture"] = text.replace("Lecture:", "").strip()
                        elif "Lab:" in text:
                            course_data["lab"] = text.replace("Lab:", "").strip()
                        elif "Credits:" in text:
                            course_data["credits"] = text.replace("Credits:", "").strip()
                else:
                    strong_tag = attr.find("strong")
                    if strong_tag:
                        label = strong_tag.text.strip() 
                        value = attr.text.replace(label, "").strip() 
                        
                        if "Prerequisite" in label:
                            course_data["prerequisites"] = value
                        elif "Corequisite" in label:
                            course_data["corequisites"] = value
                        elif "Satisfies" in label:
                            course_data["satisfies"] = value
                            
            all_courses.append(course_data)
            
        # Trying to be polite lol
        time.sleep(1)

    print(f"Successfully scraped {len(all_courses)} total courses.")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Saving to {CATALOG_PATH}")

    final_json = json.dumps(all_courses, indent=4).replace('\\u00a0', ' ')

    with open(CATALOG_PATH, "w", encoding="utf-8") as f:
        f.write(final_json)

if __name__ == "__main__":
    main()