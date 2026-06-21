#!/usr/bin/env bash
set -euo pipefail

screen_name="ls-verifier-tunnel"

if command -v screen >/dev/null 2>&1 && screen -ls | grep -q "[.]${screen_name}[[:space:]]"; then
  screen -S "$screen_name" -X quit >/dev/null 2>&1 || true
  echo "Stopped screen session $screen_name."
else
  echo "No $screen_name screen session is running."
fi
