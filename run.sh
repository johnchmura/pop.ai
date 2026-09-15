#!/bin/bash
set -e
cd "$(dirname "$0")"

semester=${1:?usage: $0 <semester> <year>}
year=${2:?}

semester=$(echo "$semester" | tr 'A-Z' 'a-z')
export SEMESTER_NAME="$(echo "${semester:0:1}" | tr 'a-z' 'A-Z')${semester:1} $year"
export SEMESTER_DATA="data/${semester}_${year}.js"

python3 build.py
envsubst < www/semester.html.tpl > "www/$(echo "$SEMESTER_NAME" | tr -d ' ' | tr 'A-Z' 'a-z').html"
python3 server.py
