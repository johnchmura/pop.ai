#!/usr/bin/env python3
"""Concatenate src/*.js into www/soda.js."""

import os

INPUT_PATH = "src/"
OUTPUT_PATH = "www/soda.js"


def sources():
    return [
        os.path.join(base, f)
        for base, _folders, files in os.walk(INPUT_PATH)
        for f in files
        if f.endswith(".js")
    ]


def build():
    data = "\n".join(
        f"// {path}\n{open(path, encoding='utf-8').read()}" for path in sources()
    )
    with open(OUTPUT_PATH, "w", encoding="utf-8") as output_file:
        output_file.write(data)
    print(f"built {OUTPUT_PATH} ({len(data.splitlines())} lines)")


if __name__ == "__main__":
    build()
