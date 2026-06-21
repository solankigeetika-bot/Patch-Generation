# Canon connection bookmarklet

Click it while on **canon.pocketfm.ai** (logged in) and it pushes the
`__session` cookie straight to the LS Verifier backend — no DevTools, no
copy-paste. The green dot in the web app lights up on the next Verify run.

---

## How it works

The bookmarklet reads the `__session` cookie from the page, then POSTs it to
`POST /update-canon-session` on the LS Verifier backend.  The backend stores
the cookie server-side and uses it for every subsequent canon fetch — so
**all users of the shared web app benefit** from one connection.

> **If `__session` is HttpOnly** (the browser won't let JS read it), the
> bookmarklet will show an alert.  Use the **Settings → manual canon cookie
> paste** field in the web app instead: open DevTools → Application → Cookies,
> copy the `__session` value, and paste it there.

---

## Setup (one time)

### 1. Get your backend URL and PROXY_SECRET

- **Backend URL** — the URL where LS Verifier is deployed, e.g.
  `https://ls-verifier-abc123-uc.a.run.app`
- **PROXY_SECRET** — the value you set in the `PROXY_SECRET` environment
  variable when deploying

### 2. Build your bookmarklet

Take the one-liner below and replace the two placeholders:

- `PASTE_BACKEND_URL` → your backend URL (no trailing slash)
- `PASTE_PROXY_SECRET` → your `PROXY_SECRET` value

```
javascript:(function(){var W="PASTE_BACKEND_URL/update-canon-session",S="PASTE_PROXY_SECRET";if(location.hostname.indexOf("canon")<0){alert("Open canon.pocketfm.ai first.");return;}var m=document.cookie.match(/(?:^|;\s*)__session=([^;]+)/);if(!m){alert("__session is HttpOnly — paste the cookie manually in LS Verifier Settings.");return;}var val=decodeURIComponent(m[1]);fetch(W,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({secret:S,canon:val})}).then(function(r){return r.json();}).then(function(d){alert(d.message||"Connected ✓");}).catch(function(e){alert("Failed: "+e);});})();
```

### 3. Add it to your bookmarks bar

- Right-click the bookmarks bar → **Add page** / **Add bookmark**
- **Name:** `Connect LS Verifier to canon`
- **URL:** paste the edited one-liner above
- Save.

(Some browsers strip `javascript:` when dragging — add the bookmark manually
and paste the URL to avoid that.)

---

## Use it

1. Open **canon.pocketfm.ai** and log in.
2. Click the **Connect LS Verifier to canon** bookmark.
3. You should see `Canon session updated ✓`.
4. In the LS Verifier web app, run **Verify** with a show slug — the green dot
   will appear and `canon_loaded: true` will be shown in the summary.

When the session expires (24 h TTL), just click the bookmark again.

---

## Readable source (for reference / editing)

```js
javascript:(function () {
  var BACKEND_URL  = "PASTE_BACKEND_URL";     // e.g. https://ls-verifier-abc.run.app
  var PROXY_SECRET = "PASTE_PROXY_SECRET";    // matches PROXY_SECRET env var

  if (location.hostname.indexOf("canon") < 0) {
    alert("Open canon.pocketfm.ai first.");
    return;
  }

  var m = document.cookie.match(/(?:^|;\s*)__session=([^;]+)/);
  if (!m) {
    alert("__session is HttpOnly — paste the cookie manually in LS Verifier Settings.");
    return;
  }

  var val = decodeURIComponent(m[1]);

  fetch(BACKEND_URL + "/update-canon-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: PROXY_SECRET, canon: val }),
  })
    .then(function (r) { return r.json(); })
    .then(function (d) { alert(d.message || "Connected ✓"); })
    .catch(function (e) { alert("Failed: " + e); });
})();
```

---

## Notes

- The backend stores the `__session` in memory **and** in `canon_session.txt`
  for restart survival.  You only need to re-click after the 24 h cookie TTL.
- Unlike the old Apps Script bookmarklet this does NOT use `mode:"no-cors"`,
  so the alert confirms the server acknowledged the cookie (not just "sent").
- The `PROXY_SECRET` in the bookmarklet is baked-in at setup time — treat it
  like a password and don't share the bookmark URL publicly.
