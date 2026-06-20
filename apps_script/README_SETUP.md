# Setup: Localization Verifier Sidebar in Google Sheets

## Steps (5 minutes)

### 1. Open Apps Script in your sheet
Extensions → Apps Script

### 2. Paste the two files
- Replace the default `Code.gs` content with `Code.gs` from this folder
- Click **+** (New file) → HTML → name it exactly **Sidebar** → paste `Sidebar.html`

### 3. Add your Script Properties
- Apps Script → Project Settings (gear icon) → Script Properties → Add script property
- Optional (chatbot may work without a key if Argus allows open access):
  - `ARGUS_API_KEY` = Argus key from Settings → Account → API Keys. Omit if Argus lets you in without one.
- Required for canon-aware answers:
  - `CANON_SESSION` = your `__session` cookie from canon.pocketfm.ai (DevTools → Application → Cookies)
  - `SHOW_SLUG` = show slug from the canon URL (e.g. `twists-of-love-revenge`)
- Optional model/URL overrides:
  - `ARGUS_BASE_URL` = `https://argus.pocketfm.org/api` (default)
  - `ARGUS_MODEL` = exact model id from Argus (default `claude-opus-4.8` — see step 3a to look it up)

> The deterministic verifier checks run with **no key at all**.

### 3a. Find the exact Argus model id
In the Apps Script editor, click **Run → listArgusModels**. It logs the full model list to the Execution Log so you can copy the exact id (e.g. `as`, `claude-opus-4.8`, etc.) and set it as `ARGUS_MODEL`.

### 4. Save and reload
- Save (Ctrl+S) → close Apps Script tab
- Reload your Google Sheet
- You'll see **Localization Verifier** in the menu bar

### 5. Open the sidebar
Localization Verifier → Open Assistant

---

## What the sidebar does

**Section 1 — Source & Target Language**
- Auto-detects language pair from the sheet name (e.g. "Seventh_Seal_Eng>FR_LSV3" → EN → FR)
- Or pick manually with the dropdowns

**Section 2 — Run Verifier**
- Reads your Localization Details + Mention Mappings tabs
- Runs all deterministic checks:
  - Missing localizations
  - Source name not translated
  - First / last name collisions across characters
  - Uniformly-flat inconsistency
  - Kinship/cultural terms in wrong language
- Shows findings with row numbers
- "Write Issues to Sheet" button → writes flagged rows to the Localization Issues column (highlighted yellow)

**Section 3 — Ask Questions**
- Chat (via Argus) about the characters and entities in your sheet
- Uses the actual sheet data as context
- Example questions:
  - "Who are all characters in the Williams family?"
  - "Is 'Montclair' used consistently for all Kaiser family members?"
  - "Which rows have missing localizations?"

---

## Requires
- A Google Sheet with tabs named "Localization Details" (or similar) and optionally "Mention Mappings"
- An Argus API key (for the chatbot section only)
- The deterministic verifier checks run without any API key
