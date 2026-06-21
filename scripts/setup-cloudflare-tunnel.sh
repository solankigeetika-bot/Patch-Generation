#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TUNNEL_NAME="${TUNNEL_NAME:-ls-verifier}"
HOSTNAME="${HOSTNAME:-}"
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:8000}"
CLOUDFLARED_DIR="${CLOUDFLARED_DIR:-$HOME/.cloudflared}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed." >&2
  exit 1
fi

if [[ ! -f "$CLOUDFLARED_DIR/cert.pem" ]]; then
  echo "Cloudflare is not logged in. Run: cloudflared tunnel login" >&2
  exit 1
fi

if [[ -z "$HOSTNAME" ]]; then
  echo "Set HOSTNAME to the stable DNS name you want, e.g.:" >&2
  echo "HOSTNAME=ls-verifier.example.com scripts/setup-cloudflare-tunnel.sh" >&2
  exit 1
fi

mkdir -p "$CLOUDFLARED_DIR"

tunnel_id="$(cloudflared tunnel list --output json 2>/dev/null | \
  python3 -c 'import json,sys; name=sys.argv[1]; data=json.load(sys.stdin); print(next((t.get("id","") for t in data if t.get("name")==name), ""))' "$TUNNEL_NAME" || true)"

if [[ -z "$tunnel_id" ]]; then
  cloudflared tunnel create "$TUNNEL_NAME"
  tunnel_id="$(cloudflared tunnel list --output json 2>/dev/null | \
    python3 -c 'import json,sys; name=sys.argv[1]; data=json.load(sys.stdin); print(next((t.get("id","") for t in data if t.get("name")==name), ""))' "$TUNNEL_NAME")"
fi

credentials_file="$CLOUDFLARED_DIR/$tunnel_id.json"
if [[ -z "$credentials_file" ]]; then
  echo "Could not find Cloudflare tunnel credentials JSON in $CLOUDFLARED_DIR." >&2
  exit 1
fi
if [[ ! -f "$credentials_file" ]]; then
  echo "Could not find Cloudflare tunnel credentials JSON: $credentials_file" >&2
  exit 1
fi

cat > "$CLOUDFLARED_DIR/ls-verifier.yml" <<YAML
tunnel: $TUNNEL_NAME
credentials-file: $credentials_file

ingress:
  - hostname: $HOSTNAME
    service: $BACKEND_URL
  - service: http_status:404
YAML

cloudflared tunnel route dns --overwrite-dns "$TUNNEL_NAME" "$HOSTNAME"

cat > "$ROOT/scripts/run-cloudflare-tunnel.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
cloudflared tunnel --config "$HOME/.cloudflared/ls-verifier.yml" run
SH
chmod +x "$ROOT/scripts/run-cloudflare-tunnel.sh"

echo "Cloudflare tunnel configured."
echo "Hostname: https://$HOSTNAME"
echo "Run it with: scripts/run-cloudflare-tunnel.sh"
