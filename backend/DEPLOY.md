# Deploy the Localization Verifier proxy (Argus)

The proxy holds **one** Argus credential and serves every localizer's sheet, so
nobody pastes tokens. Argus is publicly reachable, so the proxy can run on plain
**Cloud Run** — no VPC / internal network needed.

The proxy is OpenAI-compatible, so the existing env vars (named `MADEYE_*`) point
straight at Argus. Mapping:

| Env var | Value for Argus |
|---|---|
| `MADEYE_BASE_URL` | `https://argus.pocketfm.org/api` |
| `MADEYE_API_KEY` | your Argus token (the `eyJ...` HS256 one) — or an `sk-...` API key if your admin enables them |
| `MADEYE_MODEL` | `claude-opus-4.8` |
| `PROXY_SECRET` | any long random string (the sheet sends this; pick one) |
| `CANON_SESSION` | canon.pocketfm.ai `__session` cookie (lets the proxy fetch canon) |

---

## Steps

### 1. Pick a `PROXY_SECRET`
Any long random string, e.g. `xK9mP2vL8qR4wZ7nT3aB6cD1`. You'll use it twice
(here and in Apps Script).

### 2. Deploy to Cloud Run (one command, from the `backend/` folder)
```bash
cd backend

gcloud run deploy loc-proxy \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --set-env-vars MADEYE_BASE_URL=https://argus.pocketfm.org/api \
  --set-env-vars MADEYE_MODEL=claude-opus-4.8 \
  --set-env-vars MADEYE_API_KEY=PASTE_ARGUS_TOKEN \
  --set-env-vars PROXY_SECRET=PASTE_YOUR_SECRET \
  --set-env-vars CANON_SESSION=PASTE_CANON_COOKIE
```
Cloud Run builds the Dockerfile, deploys, and prints a **Service URL** like
`https://loc-proxy-xxxxx-el.a.run.app`. That's your `PROXY_URL`.

### 3. Verify it's live
```bash
curl https://loc-proxy-xxxxx-el.a.run.app/health
# {"status":"ok","madeye":true,"canon_session":true}
```

### 4. Point Apps Script at it
In each sheet: Apps Script → Project Settings → Script Properties:
| Property | Value |
|---|---|
| `PROXY_URL` | the Cloud Run Service URL |
| `PROXY_SECRET` | the same secret from step 1 |
| `SHOW_SLUG` | the show slug (e.g. `twists-of-love-revenge`) |

When `PROXY_URL` is set, the sidebar routes the chatbot through the proxy
automatically — no `ARGUS_API_KEY` or `CANON_SESSION` needed in the sheet.

---

## Updating the Argus token later
Until your admin enables non-expiring API keys, the Argus token in
`MADEYE_API_KEY` expires (~24h). Refresh it in **one** place:
```bash
gcloud run services update loc-proxy --region asia-south1 \
  --set-env-vars MADEYE_API_KEY=NEW_ARGUS_TOKEN
```
One update covers all localizers. (Ask me to add a `/refresh` endpoint to the
proxy if you want this automated from a single browser instead.)

## Local test before deploying
```bash
cd backend
cp .env.example .env        # fill in the Argus values above
pip install -r requirements.txt
uvicorn main:app --port 8000
curl localhost:8000/health
```
