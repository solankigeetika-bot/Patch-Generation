#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8000}"
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:${PORT}}"
SCREEN_NAME="${SCREEN_NAME:-ls-verifier-tunnel}"
LOG_FILE="${LOG_FILE:-/tmp/ls-verifier-tunnel.log}"
URL_FILE="${URL_FILE:-$ROOT/.backend-url}"
USER_EMAIL="${MADEYE_USER_EMAIL:-solanki.geetika@pocketfm.com}"
EDGE_IP_VERSION="${EDGE_IP_VERSION:-4}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed." >&2
  exit 1
fi

if ! curl -fsS --max-time 5 "$BACKEND_URL/health" >/dev/null; then
  echo "Backend is not responding at $BACKEND_URL." >&2
  echo "Start it first: scripts/start-backend.sh" >&2
  exit 1
fi

"$ROOT/scripts/stop-https-tunnel.sh" >/dev/null 2>&1 || true

: > "$LOG_FILE"
rm -f "$URL_FILE"

screen -dmS "$SCREEN_NAME" bash -lc \
  "cloudflared tunnel --url '$BACKEND_URL' --edge-ip-version '$EDGE_IP_VERSION' --no-autoupdate > '$LOG_FILE' 2>&1"

echo "Starting HTTPS tunnel for $BACKEND_URL..."
echo "Cloudflare edge IP version: $EDGE_IP_VERSION"

system_resolves() {
  python3 - "$1" <<'PY' >/dev/null 2>&1
import socket
import sys
socket.getaddrinfo(sys.argv[1], 443)
PY
}

url=""
for _ in $(seq 1 120); do
  url="$(grep -Eo 'https://[a-z0-9-]+[.]trycloudflare[.]com' "$LOG_FILE" | tail -1 || true)"
  if [[ -n "$url" ]]; then
    host="${url#https://}"
    if system_resolves "$host" && curl -fsS --max-time 10 "$url/health" >/dev/null 2>&1; then
      printf "%s\n" "$url" > "$URL_FILE"
      echo "HTTPS backend URL: $url"
      echo "Saved to: $URL_FILE"
      echo
      echo "Verify Madeye:"
      echo "curl \"$url/madeye-ping?user_email=$USER_EMAIL\""
      exit 0
    fi
  fi
  sleep 1
done

echo "Tunnel did not become healthy in time." >&2
echo "Log file: $LOG_FILE" >&2
tail -80 "$LOG_FILE" >&2 || true
exit 1
