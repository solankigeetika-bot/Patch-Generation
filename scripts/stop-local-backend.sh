#!/usr/bin/env bash
set -euo pipefail

pid_file="/tmp/ls-verifier-backend-8000.pid"
screen_name="ls-verifier-backend"

if command -v screen >/dev/null 2>&1; then
  if screen -ls | grep -q "[.]${screen_name}[[:space:]]"; then
    screen -S "$screen_name" -X quit >/dev/null 2>&1 || true
    echo "Stopped screen session $screen_name."
    rm -f "$pid_file"
    exit 0
  fi
fi

if [[ ! -f "$pid_file" ]]; then
  echo "No pid file found at $pid_file."
  exit 0
fi

pid="$(cat "$pid_file")"
if kill "$pid" >/dev/null 2>&1; then
  echo "Stopped local backend PID $pid."
else
  echo "PID $pid was not running."
fi
rm -f "$pid_file"
