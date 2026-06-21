# Setup: LS Verifier Sidebar

## Fast Path

1. Open your Google Sheet.
2. Extensions → Apps Script.
3. Replace `Code.gs` with this repo's `apps_script/Code.gs`.
4. Add an HTML file named exactly `Sidebar` and paste `apps_script/Sidebar.html`.
5. Save, reload the sheet, then open **LS Verifier → Run Mention Verifier**.
   Open **LS Verifier → Open Assistant** only when you want chat.

## Zero-config Backend Settings

After the backend is deployed, fill these constants at the top of `Code.gs`:

| Constant | Value |
|---|---|
| `BACKEND_URL` | Cloud Run backend URL |
| `BAKED_PROXY_SECRET` | same shared secret configured on backend |

That is the production setup. Localizers do not need Script Properties, Madeye
keys, AWS access, tokens, or DevTools.

## Optional Script Properties

These are only for staging/admin overrides:

| Property | Value |
|---|---|
| `BACKEND_URL` or `PROXY_URL` | backend proxy URL override |
| `PROXY_SECRET` | shared secret override |
| `SHOW_SLUG` | optional canon slug |
| `MADEYE_USER_EMAIL` | optional fallback email |

Direct personal test mode:

| Property | Value |
|---|---|
| `MADEYE_API_KEY` | Madeye key |
| `MADEYE_BASE_URL` | Madeye base URL |
| `MADEYE_MODEL` | `claude-opus-4-7` |
| `MADEYE_USER_EMAIL` | your PocketFM email |

Proxy mode is safer for shareable apps because the Madeye key stays on the
backend. Direct mode is fine for quick personal testing.

## What It Does

- Reads `Mention Mappings` first, specifically `Original Mention` vs
  `Localized Mention`.
- Uses `Localization Details` only as optional dictionary/context when present.
- Runs deterministic localization checks without any LLM spend.
- Can ask Madeye-backed questions about characters, entities, and naming
  decisions using sheet context plus optional canon context.
- Writes findings back to `Mention Mappings` when you click
  **Write Issues to Mention Mappings**.
