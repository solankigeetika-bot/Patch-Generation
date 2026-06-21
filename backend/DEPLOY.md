# Deploy The LS Verifier Proxy (Madeye)

The proxy holds one Madeye credential server-side. Google Sheets calls this
proxy with a shared `PROXY_SECRET`, and the proxy calls Madeye with
`metadata.user_email` so individual usage is attributed correctly.

## Required Env Vars

| Env var | Value |
|---|---|
| `MADEYE_API_KEY` | Madeye key from Secrets Manager |
| `MADEYE_BASE_URL` | Madeye base URL from Secrets Manager |
| `MADEYE_MODEL` | `claude-opus-4-7` for the current Geetika/localizer key |
| `MADEYE_USER_EMAIL` | fallback `@pocketfm.com` email for `metadata.user_email` |
| `PROXY_SECRET` | long random string; also put this in Apps Script properties |
| `CANON_SESSION` | optional canon.pocketfm.ai `__session` cookie |

## Local Test

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# fill .env with real Madeye values
uvicorn main:app --host 0.0.0.0 --port 8000
curl http://localhost:8000/health
```

Expected health shape:

```json
{"status":"ok","madeye":true,"user_email":true,"canon_session":false}
```

## Cloud Run

From the `backend/` folder:

```bash
gcloud run deploy loc-proxy \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --set-env-vars MADEYE_BASE_URL=PASTE_MADEYE_BASE_URL \
  --set-env-vars MADEYE_MODEL=claude-opus-4-7 \
  --set-env-vars MADEYE_API_KEY=PASTE_MADEYE_API_KEY \
  --set-env-vars MADEYE_USER_EMAIL=your.name@pocketfm.com \
  --set-env-vars PROXY_SECRET=PASTE_PROXY_SECRET \
  --set-env-vars CANON_SESSION=PASTE_CANON_COOKIE
```

Cloud Run prints a service URL like
`https://loc-proxy-xxxxx-el.a.run.app`. That is the Apps Script `BACKEND_URL`.

## Apps Script Properties

In the Apps Script project, set:

| Property | Value |
|---|---|
| `BACKEND_URL` | Cloud Run service URL |
| `PROXY_SECRET` | same secret as the proxy |
| `SHOW_SLUG` | optional canon slug, e.g. `twists-of-love-revenge` |
| `MADEYE_USER_EMAIL` | optional fallback if active user email is blank |

When `PROXY_URL` is set, no Madeye key is stored in Apps Script.
