#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -x backend/.venv/bin/uvicorn ]]; then
  python3 -m venv backend/.venv
  backend/.venv/bin/python -m pip install --upgrade pip
fi

backend/.venv/bin/pip install -r backend/requirements.txt

exec backend/.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port "${PORT:-8000}"
