#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
PROJECT_NAME="${PROJECT_NAME:-ls-verifier}"
USER_EMAIL="${MADEYE_USER_EMAIL:-}"

if ! command -v vercel >/dev/null 2>&1; then
  echo "vercel CLI is not installed." >&2
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

required=(
  MADEYE_API_KEY
  MADEYE_BASE_URL
  MADEYE_MODEL
  MADEYE_USER_EMAIL
  PROXY_SECRET
)

missing=()
for key in "${required[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    missing+=("$key")
  fi
done

if (( ${#missing[@]} )); then
  echo "Missing required env var(s): ${missing[*]}" >&2
  echo "Fill $ENV_FILE or export them before deploying." >&2
  exit 1
fi

if ! vercel whoami >/dev/null 2>&1; then
  echo "Vercel is not logged in. Run: vercel login" >&2
  exit 1
fi

cd "$ROOT"

if [[ ! -d .vercel ]]; then
  vercel link --yes --project "$PROJECT_NAME"
fi

set_env() {
  local name="$1"
  local value="$2"
  vercel env add "$name" production --force --yes --sensitive --value "$value" >/dev/null
}

set_env MADEYE_API_KEY "$MADEYE_API_KEY"
set_env MADEYE_BASE_URL "$MADEYE_BASE_URL"
set_env MADEYE_MODEL "$MADEYE_MODEL"
set_env MADEYE_USER_EMAIL "$MADEYE_USER_EMAIL"
set_env PROXY_SECRET "$PROXY_SECRET"
set_env CANON_HOST "${CANON_HOST:-https://canon.pocketfm.ai}"
set_env LLM_VERIFY_LIMIT "${LLM_VERIFY_LIMIT:-80}"

deployment_url="$(vercel deploy --prod --yes)"
url="https://${PROJECT_NAME}.vercel.app"
echo "Deployment URL: $deployment_url"
echo "Stable alias: $url"

echo "Health check:"
curl -fsS "$url/health"
echo

echo "Madeye ping:"
curl -fsS "$url/madeye-ping?user_email=${USER_EMAIL}"
echo
