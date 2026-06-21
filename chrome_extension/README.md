# LS Verifier Chrome Extension

This is the browser-agent version of the LS verifier. It is meant to replace
bookmarklets and reduce Apps Script friction while keeping the Madeye key out of
the browser.

## What it does

- Opens as a Chrome side panel.
- Reads the active Google Sheet through the Google Sheets API.
- Reads `Mention Mappings` first and uses `Localization Details` as context.
- Runs backend `/verify-mentions` in either:
  - all-checks mode
  - Opus cultural/naturalness mode
- Writes issues, suggested localized mentions, and confidence scores back to
  `Mention Mappings`.
- Replaces `X -> Y` across relevant localized fields only.
- Captures Story Canon data from `canon.pocketfm.ai` and pushes it to the
  backend.

## What it does not do

- It does not store `MADEYE_API_KEY`.
- It does not call Madeye directly.
- It still needs a backend that can reach Madeye.
- It stores the backend URL/proxy secret in Chrome local extension storage on
  the current machine, not synced browser storage.

## Local install for testing

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `chrome_extension`.
5. Open a Google Sheet.
6. Click the LS Verifier extension icon.
7. Fill:
   - Backend URL: `http://127.0.0.1:8000` for local testing, or your deployed
     HTTPS backend URL for sharing
   - Proxy Secret: backend shared proxy secret
8. Click **Load Sheet**, then **Run All Checks** or **Run Opus Cultural Check**.

## Google OAuth requirement

The OAuth client in `manifest.json` is configured for this pinned Chrome
extension ID:

```text
eafhnjhcebpgkpdgfgjigiohfckkdgbo
```

If you create a new extension package with a different ID, create a new
**Chrome Extension** OAuth client in Google Cloud and replace the `client_id`.

Required scopes:

- `openid`
- `email`
- `profile`
- `https://www.googleapis.com/auth/spreadsheets`

## Backend requirement

Use a backend URL only after this passes:

```bash
curl "https://YOUR_BACKEND/madeye-ping?user_email=solanki.geetika@pocketfm.com"
```

`https://ls-verifier.vercel.app` is stable but currently cannot reach internal
Madeye, so it is not valid for the Opus path unless Madeye networking changes.

For local testing, start the backend and use:

```bash
scripts/start-backend.sh
curl "http://127.0.0.1:8000/madeye-ping?user_email=solanki.geetika@pocketfm.com"
```
