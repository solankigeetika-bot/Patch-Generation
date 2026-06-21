# Deploy The LS Verifier

The backend holds all credentials server-side. Localizers open the web app URL — no login, no per-user setup, nothing to install.

## Required Env Vars

| Env var | Value |
|---|---|
| `MADEYE_API_KEY` | Madeye key from Secrets Manager |
| `MADEYE_BASE_URL` | Madeye base URL from Secrets Manager |
| `MADEYE_MODEL` | `claude-opus-4-7` for the current Geetika/localizer key |
| `MADEYE_USER_EMAIL` | fallback `@pocketfm.com` email for `metadata.user_email` |
| `PROXY_SECRET` | long random string; also bake into the canon bookmarklet |
| `CANON_SESSION` | optional — canon bookmarklet keeps this fresh at runtime |

---

## Auto-deploy via GitHub Actions (recommended)

Push to `main` → the workflow in `.github/workflows/deploy.yml` builds and deploys automatically. The Cloud Run URL appears in the Actions job summary.

### One-time setup (5 min)

**1. Create a GCP service account**

```bash
gcloud iam service-accounts create github-deployer \
  --display-name "GitHub Actions deployer"

SA="github-deployer@YOUR_PROJECT.iam.gserviceaccount.com"

# Roles needed: build the image, deploy the service, write to GCS
gcloud projects add-iam-policy-binding YOUR_PROJECT \
  --member="serviceAccount:$SA" --role="roles/run.admin"
gcloud projects add-iam-policy-binding YOUR_PROJECT \
  --member="serviceAccount:$SA" --role="roles/cloudbuild.builds.editor"
gcloud projects add-iam-policy-binding YOUR_PROJECT \
  --member="serviceAccount:$SA" --role="roles/storage.admin"
gcloud projects add-iam-policy-binding YOUR_PROJECT \
  --member="serviceAccount:$SA" --role="roles/iam.serviceAccountUser"

# Download the JSON key
gcloud iam service-accounts keys create sa-key.json --iam-account="$SA"
```

**2. Add GitHub Secrets**

In the repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
|--------|-------|
| `GCP_SA_KEY` | contents of `sa-key.json` (the entire JSON) |
| `GCP_PROJECT_ID` | your GCP project ID (e.g. `pocketfm-prod`) |
| `MADEYE_API_KEY` | from AWS Secrets Manager |
| `MADEYE_BASE_URL` | from AWS Secrets Manager |
| `MADEYE_USER_EMAIL` | `solanki.geetika@pocketfm.com` |
| `PROXY_SECRET` | any long random string |
| `CANON_SESSION` | leave blank — bookmarklet updates this at runtime |

After adding, **delete `sa-key.json`** from your machine.

**3. Merge to main**

The deploy job runs automatically on every push to `main`. Check the **Actions tab** for the job summary which prints the live URL.

You can also trigger a deploy manually: Actions → "Deploy to Cloud Run" → Run workflow.

---

## Local test

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# fill .env with real Madeye values
uvicorn main:app --host 0.0.0.0 --port 8000
```

Open http://localhost:8000 — the full web app loads. Layer 1 (deterministic) works without credentials. LLM and canon require the network + real keys.

Expected health:
```json
{"status":"ok","madeye":true,"user_email":true,"canon_session":false}
```

---

## Manual Cloud Run deploy (if not using Actions)

From the **repo root**:

```bash
gcloud run deploy loc-proxy \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --set-env-vars MADEYE_BASE_URL=PASTE_MADEYE_BASE_URL \
  --set-env-vars MADEYE_MODEL=claude-opus-4-7 \
  --set-env-vars MADEYE_API_KEY=PASTE_MADEYE_API_KEY \
  --set-env-vars MADEYE_USER_EMAIL=your.name@pocketfm.com \
  --set-env-vars PROXY_SECRET=PASTE_PROXY_SECRET
```

The service URL (e.g. `https://loc-proxy-xxxxx-el.a.run.app`) is also the `BACKEND_URL` for the canon bookmarklet in `apps_script/canon_bookmarklet.md`.
