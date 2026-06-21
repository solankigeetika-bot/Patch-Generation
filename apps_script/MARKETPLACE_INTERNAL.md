# Google Workspace Marketplace Internal Rollout

Recommended path: publish LS Verifier as a Google Workspace Marketplace
internal app for `pocketfm.com`.

Official Google references:

- Publish overview:
  https://developers.google.com/workspace/add-ons/how-tos/publish-add-on-overview
- Marketplace SDK configuration:
  https://developers.google.com/workspace/marketplace/enable-configure-sdk
- Apps Script standard Cloud projects:
  https://developers.google.com/apps-script/guides/cloud-platform-projects

## What This Repo Is Ready For

- The add-on is a Sheets Editor add-on.
- The visible app name is `LS Verifier`.
- The default menu action is:
  `Extensions -> LS Verifier -> Run Mention Verifier`.
- The verifier reads `Mention Mappings` first:
  `Original Mention` vs `Localized Mention`.
- `Localization Details` is optional dictionary/context when present.
- Localizers do not need Madeye keys. Apps Script sends their active Google
  email to the backend, and the backend forwards it as Madeye
  `metadata.user_email`.

## Before Publishing

1. Deploy the backend to Cloud Run.
2. Confirm these pass:

   ```bash
   curl https://YOUR_BACKEND_URL/health
   curl "https://YOUR_BACKEND_URL/madeye-ping?user_email=solanki.geetika@pocketfm.com"
   ```

3. In `apps_script/Code.gs`, fill:

   ```js
   var BACKEND_URL = "https://YOUR_BACKEND_URL";
   var BAKED_PROXY_SECRET = "THE_SHARED_BACKEND_PROXY_SECRET";
   ```

4. Create or update the Apps Script project with:
   - `Code.gs`
   - `Sidebar.html`
   - `appsscript.json`

5. Test the add-on on a real LS sheet:
   `Extensions -> LS Verifier -> Run Mention Verifier`.

## Marketplace Internal App Steps

1. Create a dedicated standard Google Cloud project for LS Verifier.
   Google says the Apps Script default Cloud project cannot be used to publish
   an add-on.
2. In Apps Script project settings, switch the script to that standard Cloud
   project.
3. Create an Apps Script version and record the version number.
4. In Google Cloud, enable and configure the Google Workspace Marketplace SDK.
5. In Marketplace SDK App Configuration:
   - Choose Editor add-on.
   - Select Google Sheets.
   - Enter the Apps Script project script ID.
   - Enter the Apps Script version number.
   - Add the OAuth scopes from `appsscript.json`.
   - Set visibility/install settings for internal PocketFM use.
6. Complete the store listing, OAuth consent screen, and required support links.
7. Publish internally or ask the Workspace admin to domain-install it.

## New Localizer Flow

After internal publication/domain install:

1. Open the LS sheet.
2. Extensions -> LS Verifier -> Run Mention Verifier.
3. Review the columns written back to `Mention Mappings`.

No AWS, no Madeye key, no Script Properties, no token refresh.
