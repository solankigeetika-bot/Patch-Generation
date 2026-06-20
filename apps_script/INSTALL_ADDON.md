# Install as a Sheets Editor Add-on (not seat-specific)

Instead of pasting code into each sheet, you package this once as a **Google
Workspace Editor Add-on**. Install it on your account → it appears under
**Extensions → Localization Verifier** in *every* spreadsheet you open. Click
it whenever you want to run the verifier or ask a question.

Files that make up the add-on:
- `Code.gs` — server logic (verifier, chatbot, canon)
- `Sidebar.html` — the UI
- `appsscript.json` — the add-on manifest (this is what makes it an add-on)

---

## A. Create the add-on project (one time)

1. Go to **https://script.google.com** → **New project**.
2. Rename it (top-left) to **Localization Verifier**.
3. **Project Settings** (⚙ gear icon) → check
   **"Show 'appsscript.json' manifest file in editor"**.
4. Back in the **Editor** (`< >`):
   - Open `Code.gs`, select all, paste the contents of this repo's `Code.gs`.
   - **+ → HTML** → name it exactly **`Sidebar`** → paste `Sidebar.html`.
   - Open **`appsscript.json`** → select all → paste this repo's `appsscript.json`.
5. **Save** (Ctrl/Cmd+S).

## B. Set the Script Properties

**Project Settings** (⚙) → **Script Properties** → add:

Direct-to-Argus (testing, just you):
| Property | Value |
|---|---|
| `ARGUS_API_KEY` | your Argus token (`eyJ...`) |
| `ARGUS_MODEL` | `claude-opus-4.8` |

Or proxy mode (scalable, the team — see `backend/DEPLOY.md`):
| Property | Value |
|---|---|
| `PROXY_URL` | the Cloud Run service URL |
| `PROXY_SECRET` | the shared secret |
| `SHOW_SLUG` | e.g. `twists-of-love-revenge` |

(When `PROXY_URL` is set, no Argus token is needed in the sheet.)

## C. Install it on your account (test deployment)

1. **Deploy** (top-right) → **Test deployments**.
2. You'll see a Sheets add-on entry → click **Install** → **Done**.
3. Open **any** Google Sheet (or refresh one) → **Extensions** menu →
   **Localization Verifier** → **Open Assistant**.
4. First run asks for permissions → **Review permissions** → your account →
   **Allow**.

That's it — the assistant is now available in every sheet you open, on demand.

---

## D. Roll it out to the whole team (later)

Two options, pick one:

- **Each localizer self-installs** the test deployment (repeat step C on their
  account). Quick, no admin needed.
- **Publish privately to your domain** via the Google Workspace Marketplace SDK
  so a Workspace admin can push it to everyone at once (no per-person install).
  This needs a GCP project + the Marketplace SDK; ask me and I'll write the
  manifest + listing steps.

For the team, use **proxy mode** (Script Properties `PROXY_URL` + `PROXY_SECRET`)
so one server-side Argus credential serves everyone and nobody handles tokens.

---

## Notes
- Scope `spreadsheets.currentonly` means the add-on only reads the sheet you
  currently have open — it can't see your other files.
- The `doPost`/`doGet` token-sync web app is independent of the add-on; deploy
  it separately (Deploy → New deployment → Web app) only if you use the
  Tampermonkey auto-refresh flow.
