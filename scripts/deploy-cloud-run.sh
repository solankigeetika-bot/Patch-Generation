#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
SERVICE="${SERVICE:-loc-proxy}"
REGION="${REGION:-asia-south1}"
PROJECT="${GCP_PROJECT_ID:-${GOOGLE_CLOUD_PROJECT:-}}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is not installed. Install Google Cloud CLI first." >&2
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "$PROJECT" ]]; then
  echo "No GCP project set. Run: gcloud config set project YOUR_PROJECT_ID" >&2
  exit 1
fi

active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -1)"
if [[ -z "$active_account" ]]; then
  echo "No active gcloud account. Run: gcloud auth login" >&2
  exit 1
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

tmp_env="$(mktemp)"
chmod 600 "$tmp_env"
cleanup() { rm -f "$tmp_env"; }
trap cleanup EXIT

yaml_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/''/g")"
}

{
  printf "MADEYE_API_KEY: "; yaml_quote "$MADEYE_API_KEY"; printf "\n"
  printf "MADEYE_BASE_URL: "; yaml_quote "$MADEYE_BASE_URL"; printf "\n"
  printf "MADEYE_MODEL: "; yaml_quote "$MADEYE_MODEL"; printf "\n"
  printf "MADEYE_USER_EMAIL: "; yaml_quote "$MADEYE_USER_EMAIL"; printf "\n"
  printf "PROXY_SECRET: "; yaml_quote "$PROXY_SECRET"; printf "\n"
  printf "CANON_HOST: "; yaml_quote "${CANON_HOST:-https://canon.pocketfm.ai}"; printf "\n"
  printf "LLM_VERIFY_LIMIT: "; yaml_quote "${LLM_VERIFY_LIMIT:-80}"; printf "\n"
} > "$tmp_env"

echo "Deploying $SERVICE to Cloud Run project=$PROJECT region=$REGION as $active_account"
gcloud run deploy "$SERVICE" \
  --project="$PROJECT" \
  --source "$ROOT" \
  --region "$REGION" \
  --allow-unauthenticated \
  --env-vars-file "$tmp_env"

url="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT" \
  --region "$REGION" \
  --format 'value(status.url)')"

echo
echo "Cloud Run URL: $url"
echo "Health check:"
curl -fsS "$url/health"
echo
