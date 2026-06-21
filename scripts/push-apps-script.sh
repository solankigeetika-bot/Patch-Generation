#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_ID="${SCRIPT_ID:-}"
VERSION_DESC="${VERSION_DESC:-LS Verifier update}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

BACKEND_URL="${BACKEND_URL:-${PROXY_URL:-}}"
PROXY_SECRET="${PROXY_SECRET:-}"

if ! command -v clasp >/dev/null 2>&1; then
  echo "clasp is not installed. Run: npm install -g @google/clasp" >&2
  exit 1
fi

if [[ -z "$SCRIPT_ID" ]]; then
  echo "Set SCRIPT_ID to the Apps Script project ID before pushing." >&2
  echo "Example: SCRIPT_ID=abc123 scripts/push-apps-script.sh" >&2
  exit 1
fi

if [[ "${ALLOW_EMPTY_CONFIG:-}" != "1" ]]; then
  if [[ -z "$BACKEND_URL" || -z "$PROXY_SECRET" ]]; then
    echo "BACKEND_URL and PROXY_SECRET are required for a zero-config shared add-on." >&2
    echo "Export them, add them to $ENV_FILE, or set ALLOW_EMPTY_CONFIG=1 for a staging push." >&2
    exit 1
  fi
fi

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

cp "$ROOT/apps_script/Code.gs" "$tmp/Code.js"
cp "$ROOT/apps_script/Sidebar.html" "$tmp/Sidebar.html"
cp "$ROOT/apps_script/appsscript.json" "$tmp/appsscript.json"

if [[ -n "$BACKEND_URL" || -n "$PROXY_SECRET" ]]; then
  BACKEND_URL="$BACKEND_URL" PROXY_SECRET="$PROXY_SECRET" node - "$tmp/Code.js" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
let code = fs.readFileSync(path, "utf8");
const backendUrl = process.env.BACKEND_URL || "";
const proxySecret = process.env.PROXY_SECRET || "";
code = code.replace(
  /var BACKEND_URL = ".*?";/,
  "var BACKEND_URL = " + JSON.stringify(backendUrl.replace(/\/+$/, "")) + ";"
);
code = code.replace(
  /var BAKED_PROXY_SECRET = ".*?";/,
  "var BAKED_PROXY_SECRET = " + JSON.stringify(proxySecret) + ";"
);
fs.writeFileSync(path, code);
NODE
fi

cat > "$tmp/.clasp.json" <<JSON
{"scriptId":"$SCRIPT_ID","rootDir":"."}
JSON

cat > "$tmp/.claspignore" <<'EOF'
**/**
!Code.js
!Sidebar.html
!appsscript.json
EOF

echo "Pushing Apps Script project $SCRIPT_ID"
if [[ -n "$BACKEND_URL" ]]; then
  echo "Using backend: ${BACKEND_URL%/}"
fi
if [[ "${DRY_RUN:-}" == "1" ]]; then
  if grep -q 'var BACKEND_URL = "";' "$tmp/Code.js"; then
    echo "Dry run failed: BACKEND_URL was not injected." >&2
    exit 1
  fi
  if [[ "${ALLOW_EMPTY_CONFIG:-}" != "1" ]] && grep -q 'var BAKED_PROXY_SECRET = "";' "$tmp/Code.js"; then
    echo "Dry run failed: BAKED_PROXY_SECRET was not injected." >&2
    exit 1
  fi
  echo "Dry run OK: Apps Script package prepared."
  exit 0
fi
(
  cd "$tmp"
  clasp push --force
  clasp version "$VERSION_DESC"
)

echo "Apps Script source pushed and versioned."
echo "Open the project:"
echo "https://script.google.com/d/$SCRIPT_ID/edit"
