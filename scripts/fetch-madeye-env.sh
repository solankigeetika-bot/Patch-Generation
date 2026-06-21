#!/usr/bin/env bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-pocketfm}"
REGION="${AWS_REGION:-ap-southeast-1}"
SECRET_ID="${MADEYE_SECRET_ID:-}"
MODEL="${MADEYE_MODEL:-claude-opus-4-7}"
USER_EMAIL="${MADEYE_USER_EMAIL:-}"

if [[ -z "$SECRET_ID" ]]; then
  echo "Set MADEYE_SECRET_ID to your AWS Secrets Manager path, e.g. prod/argus/<owner>." >&2
  exit 1
fi

if [[ -z "$USER_EMAIL" ]]; then
  printf "Enter MADEYE_USER_EMAIL: " >&2
  read -r USER_EMAIL
fi

if [[ -z "$USER_EMAIL" ]]; then
  echo "MADEYE_USER_EMAIL is required." >&2
  exit 1
fi

secret_json="$(
  aws secretsmanager get-secret-value \
    --profile "$PROFILE" \
    --secret-id "$SECRET_ID" \
    --region "$REGION" \
    --query SecretString \
    --output text
)"

SECRET_JSON="$secret_json" USER_EMAIL="$USER_EMAIL" MODEL="$MODEL" python3 - <<'PY'
import json
import os
import pathlib
import secrets

secret = json.loads(os.environ["SECRET_JSON"])
api_key = secret.get("MADEYE_API_KEY", "")
base_url = secret.get("MADEYE_BASE_URL", "")
if not api_key or not base_url:
    raise SystemExit("Secret must contain MADEYE_API_KEY and MADEYE_BASE_URL")

proxy_secret = secrets.token_hex(32)
contents = "\n".join([
    f'MADEYE_API_KEY="{api_key}"',
    f'MADEYE_BASE_URL="{base_url}"',
    f'MADEYE_USER_EMAIL="{os.environ["USER_EMAIL"]}"',
    f'MADEYE_MODEL="{os.environ["MODEL"]}"',
    f'PROXY_SECRET="{proxy_secret}"',
    'CANON_SESSION=""',
    "",
])

for name in [".env", "backend/.env"]:
    path = pathlib.Path(name)
    path.write_text(contents)
    path.chmod(0o600)

print("Wrote .env and backend/.env. Madeye key was not printed.")
PY
