# One-click token bookmarklet

Click it while on **argus.pocketfm.org** (or **canon.pocketfm.ai**) and it pushes
the fresh token/cookie straight into your sheet's Script Properties — no DevTools,
no copy-paste. Refresh expired? Just click the bookmark again.

---

## How it works
The bookmarklet reads `localStorage.token` (Argus) or the `__session` cookie
(canon) on the page you're viewing, then POSTs it to your script's web app
(`doPost`), which saves it as `ARGUS_API_KEY` / `CANON_SESSION`.

---

## Setup (one time)

### 1. Deploy the script as a Web App (gives you the URL the bookmarklet calls)
In your sheet's Apps Script:
1. **Deploy → New deployment → Web app**
2. **Execute as:** Me · **Who has access:** Anyone
3. **Deploy** → copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`)

### 2. Set the shared secret
⚙ Project Settings → Script Properties → add
`REFRESH_SECRET` = any long random string (you'll paste the same one below).

### 3. Build your bookmarklet
Take the one-liner below and replace the two placeholders:
- `PASTE_WEB_APP_URL` → the Web app URL from step 1
- `PASTE_REFRESH_SECRET` → the secret from step 2

```
javascript:(function(){var W="PASTE_WEB_APP_URL",S="PASTE_REFRESH_SECRET",h=location.hostname,p={secret:S};if(h.indexOf("argus")>-1){var t=localStorage.getItem("token");if(!t){alert("Argus token not found — log in first.");return;}p.token=t;}else if(h.indexOf("canon")>-1){var m=document.cookie.match(/(?:^|;\s*)__session=([^;]+)/);if(!m){alert("__session is HttpOnly — a bookmarklet can't read it. Use the manual paste for canon.");return;}p.canon=decodeURIComponent(m[1]);}else{alert("Open argus.pocketfm.org or canon.pocketfm.ai first.");return;}fetch(W,{method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify(p)}).then(function(){alert("✓ Sent to your sheet: "+(p.token?"Argus token":"canon cookie"));}).catch(function(e){alert("Failed: "+e);});})();
```

### 4. Add it to your bookmarks bar
- Right-click the bookmarks bar → **Add page** / **Add bookmark**
- **Name:** `Sync Argus token`
- **URL:** paste the edited one-liner from step 3
- Save.

(Some browsers strip `javascript:` when you drag — adding the bookmark manually
and pasting the URL avoids that.)

---

## Use it
1. Open **argus.pocketfm.org**, log in.
2. Click the **Sync Argus token** bookmark → you'll see `✓ Sent to your sheet`.
3. (Optional) Open **canon.pocketfm.ai** and click it again to push the canon
   cookie — *if* `__session` isn't HttpOnly.

That's it. When Argus says 401 again, just click the bookmark.

---

## Readable source (for reference / editing)
```js
javascript:(function () {
  var WEBAPP_URL = "PASTE_WEB_APP_URL";       // Web app /exec URL
  var SECRET     = "PASTE_REFRESH_SECRET";    // matches REFRESH_SECRET prop
  var host = location.hostname;
  var payload = { secret: SECRET };

  if (host.indexOf("argus") > -1) {
    var t = localStorage.getItem("token");
    if (!t) { alert("Argus token not found — log in first."); return; }
    payload.token = t;
  } else if (host.indexOf("canon") > -1) {
    var m = document.cookie.match(/(?:^|;\s*)__session=([^;]+)/);
    if (!m) { alert("__session is HttpOnly — a bookmarklet can't read it."); return; }
    payload.canon = decodeURIComponent(m[1]);
  } else {
    alert("Open argus.pocketfm.org or canon.pocketfm.ai first."); return;
  }

  fetch(WEBAPP_URL, {
    method: "POST",
    mode: "no-cors",                          // Apps Script sends no CORS headers
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  })
  .then(function () {
    alert("✓ Sent to your sheet: " + (payload.token ? "Argus token" : "canon cookie"));
  })
  .catch(function (e) { alert("Failed: " + e); });
})();
```

## Notes
- `mode:"no-cors"` means the browser won't let the bookmarklet read the reply,
  so you get a "Sent" alert rather than a server-confirmed one. To verify it
  landed, check Script Properties or just try the sidebar again.
- If the canon `__session` cookie is HttpOnly (common), keep using the manual
  paste for `CANON_SESSION` — or move canon fetching to the proxy, which holds
  the cookie server-side and sidesteps this entirely.
