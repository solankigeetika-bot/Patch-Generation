# Install As A Sheets Editor Add-on

This packages LS Verifier once so it appears under
**Extensions → LS Verifier** in every spreadsheet you open.

## Create The Add-on Project

1. Go to `https://script.google.com` → **New project**.
2. Rename it to **LS Verifier**.
3. Project Settings → enable **Show appsscript.json manifest file in editor**.
4. Paste these repo files into the Apps Script project:
   - `Code.gs`
   - `Sidebar.html` as an HTML file named exactly `Sidebar`
   - `appsscript.json`
5. Save.

## Recommended: Zero-config Proxy Mode

Use this for anything shared with a team. The Madeye key stays in the backend,
not in Apps Script.

After Cloud Run is deployed, fill these constants at the top of `Code.gs`:

| Constant | Value |
|---|---|
| `BACKEND_URL` | Cloud Run service URL |
| `BAKED_PROXY_SECRET` | same shared secret configured on the backend |

For CLI publishing, do **not** commit those values to git. Use the helper from
the repo root instead:

```bash
SCRIPT_ID=your_apps_script_project_id \
BACKEND_URL=https://your-cloud-run-url \
PROXY_SECRET=the_backend_proxy_secret \
scripts/push-apps-script.sh
```

The helper injects `BACKEND_URL` and `BAKED_PROXY_SECRET` into a temporary upload
copy, pushes it with `clasp`, and creates a new Apps Script version.
To also create a pinned deployment for the new version, add `DEPLOY=1`:

```bash
SCRIPT_ID=your_apps_script_project_id \
BACKEND_URL=https://your-cloud-run-url \
PROXY_SECRET=the_backend_proxy_secret \
DEPLOY=1 \
scripts/push-apps-script.sh
```

Then publish the add-on. Localizers do not set Script Properties and never see a
Madeye key. Their email is read with `Session.getActiveUser().getEmail()` and
sent through the backend as Madeye `metadata.user_email`.

Script Properties still work as admin/staging overrides:

| Property | Value |
|---|---|
| `BACKEND_URL` or `PROXY_URL` | temporary backend override |
| `PROXY_SECRET` | temporary shared secret override |
| `SHOW_SLUG` | optional canon slug |
| `MADEYE_USER_EMAIL` | fallback email if Google does not expose active user email |

## Direct Mode For Personal Testing

Only use this for your own test project. The key is stored in Apps Script
properties, not exposed in the sheet UI.

| Property | Value |
|---|---|
| `MADEYE_API_KEY` | your Madeye key |
| `MADEYE_BASE_URL` | Madeye base URL |
| `MADEYE_MODEL` | `claude-opus-4-7` |
| `MADEYE_USER_EMAIL` | your PocketFM email |

## Install For Yourself

1. Deploy → **Test deployments**.
2. Select the Sheets add-on entry → **Install**.
3. Open or refresh a Google Sheet.
4. Extensions → LS Verifier → Run Mention Verifier.
5. Use **Extensions → LS Verifier → Open Assistant** only when you want the
   chat assistant.
6. Approve permissions on first run.

The default verifier reads the `Mention Mappings` tab first and checks
`Original Mention` against `Localized Mention`. `Localization Details` is only
used as optional dictionary/context when present.

The deterministic verifier works without Madeye. The chat/LLM review needs
proxy mode or direct Madeye mode.

## Recommended Rollout

Use a Google Workspace Marketplace **internal app** for PocketFM. That gives
localizers a one-click install path and avoids copy/paste setup in individual
sheets. A shared Apps Script project is okay for early testing, but it will not
feel like a real zero-config tool.

See `MARKETPLACE_INTERNAL.md` for the exact internal Marketplace checklist.
