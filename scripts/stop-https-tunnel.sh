#!/usr/bin/env bash
set -euo pipefail

screen_name="${SCREEN_NAME:-ls-verifier-tunnel}"
port="${PORT:-8000}"
stopped=0

if command -v screen >/dev/null 2>&1; then
  while read -r session; do
    [[ -z "$session" ]] && continue
    screen -S "$session" -X quit >/dev/null 2>&1 || true
    stopped=1
  done < <(screen -ls | awk -v name="$screen_name" '$1 ~ "[.]" name "$" {print $1}')
fi

while read -r pid; do
  [[ -z "$pid" ]] && continue
  kill "$pid" >/dev/null 2>&1 || true
  stopped=1
done < <(pgrep -f "^cloudflared tunnel --url http://127[.]0[.]0[.]1:${port}" || true)

if [[ "$stopped" == "1" ]]; then
  echo "Stopped $screen_name tunnel."
else
  echo "No $screen_name tunnel is running."
fi
