#!/bin/bash
# Stop any previous Pop stack, then start semantic API + static server (SQLite + sqlite-vec).
set -e
cd "$(dirname "$0")"

semester=fall
year=2026
reindex=0

for arg in "$@"; do
  case "$arg" in
    --reindex) reindex=1 ;;
    spring|summer|fall) semester="$arg" ;;
    [0-9][0-9][0-9][0-9]) year="$arg" ;;
    -h|--help)
      echo "usage: $0 [semester] [year] [--reindex]"
      echo "  example: $0 fall 2026"
      echo "  example: $0 fall 2026 --reindex"
      exit 0
      ;;
    *)
      echo "usage: $0 [semester] [year] [--reindex]" >&2
      exit 1
      ;;
  esac
done

semester=$(echo "$semester" | tr 'A-Z' 'a-z')

kill_port() {
  local port=$1
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" 2>/dev/null || true
  elif command -v lsof >/dev/null 2>&1; then
    local pids
    pids=$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$pids" ]; then
      kill $pids 2>/dev/null || true
    fi
  fi
}

stop_stack() {
  echo "Stopping Pop servers..."
  if [ -n "${API_PID:-}" ]; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
    API_PID=
  fi
  kill_port 8000
  kill_port 8001
  pkill -f "uvicorn api:app" 2>/dev/null || true
  pkill -f "uvicorn api.main:app" 2>/dev/null || true
  pkill -f "[Pp]ython3? server.py" 2>/dev/null || true
  sleep 1
}

cleanup() {
  stop_stack
  echo "Shutdown complete."
}

stop_stack

catalog_n=$(python3 -c "from db import catalog_count; print(catalog_count())" 2>/dev/null || echo 0)
semester_n=$(python3 -c "from db import get_semester; print(1 if get_semester(season='${semester}', year=${year}) else 0)" 2>/dev/null || echo 0)
if [ "${catalog_n:-0}" -eq 0 ] || [ "${semester_n:-0}" -eq 0 ]; then
  if [ -f "www/data/full_catalog.json" ] || [ -f "www/data/${semester}_${year}.json" ]; then
    echo "Seeding SQLite from www/data..."
    python3 import_data.py --all-semesters
  fi
fi

need_index=$reindex
if [ "$need_index" -eq 0 ]; then
  emb_n=$(python3 -c "from db import embedding_count; print(embedding_count(season='${semester}', year=${year}))" 2>/dev/null || echo 0)
  if [ "${emb_n:-0}" -eq 0 ]; then
    echo "No embeddings for ${semester} ${year}; will reindex."
    need_index=1
  fi
fi

if [ "$need_index" -eq 1 ]; then
  echo "Indexing ${semester} ${year} into SQLite (sqlite-vec)..."
  python3 index_semester.py "$semester" "$year"
fi

echo "Exporting ${semester} ${year} JS from SQLite for the UI..."
python3 -c "from db import write_semester_files; write_semester_files('${semester}', ${year})"

export SEMESTER_NAME="$(echo "${semester:0:1}" | tr 'a-z' 'A-Z')${semester:1} $year"
export SEMESTER_DATA="data/${semester}_${year}.js"
html_name="$(echo "$SEMESTER_NAME" | tr -d ' ' | tr 'A-Z' 'a-z').html"

python3 build.py
envsubst < www/semester.html.tpl > "www/${html_name}"

trap cleanup EXIT INT TERM

echo "Starting semantic API on :8001 and static server on :8000..."
echo "Open http://localhost:8000/${html_name}"
echo "Shift+Enter runs semantic search. Ctrl+C shuts everything down."

python3 -m uvicorn api:app --host 127.0.0.1 --port 8001 &
API_PID=$!

python3 server.py
