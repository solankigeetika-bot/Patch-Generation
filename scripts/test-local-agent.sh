#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8000}"
BASE_URL="http://127.0.0.1:${PORT}"
USER_EMAIL="${MADEYE_USER_EMAIL:-solanki.geetika@pocketfm.com}"

cd "$ROOT"

proxy_secret="$(
  python3 - <<'PY'
from pathlib import Path
for candidate in (Path("backend/.env"), Path(".env")):
    if not candidate.exists():
        continue
    for line in candidate.read_text().splitlines():
        if line.startswith("PROXY_SECRET="):
            print(line.split("=", 1)[1].strip().strip('"'))
            raise SystemExit
PY
)"

if [[ -z "$proxy_secret" ]]; then
  echo "PROXY_SECRET not found in backend/.env or .env." >&2
  exit 1
fi

echo "1) /health"
curl -fsS "${BASE_URL}/health"
echo

echo "2) /madeye-ping"
curl -fsS "${BASE_URL}/madeye-ping?user_email=${USER_EMAIL}"
echo

echo "3) /chat"
curl -fsS -X POST "${BASE_URL}/chat" \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Secret: ${proxy_secret}" \
  --data @- <<JSON
{
  "question": "Reply in one short sentence: what should this verifier inspect first?",
  "sheet_context": "Mention Mappings (Original Mention -> Localized Mention):\\n  Alice -> Alicia\\n  Mr Alice -> Monsieur Alicia",
  "source_lang": "en",
  "target_lang": "fr",
  "user_email": "${USER_EMAIL}"
}
JSON
echo
