function extractObjectFromScripts(name) {
  const scripts = Array.from(document.scripts)
    .map((script) => script.textContent || "")
    .sort((a, b) => b.length - a.length);

  for (const text of scripts) {
    const idx = text.indexOf(name);
    if (idx < 0) continue;
    const start = text.indexOf("{", idx);
    if (start < 0) continue;

    let depth = 0;
    let end = -1;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }

    if (end > start) {
      try {
        return JSON.parse(text.slice(start, end));
      } catch {
        // Keep scanning; Story Canon builds have changed shape before.
      }
    }
  }
  return null;
}

function captureCanon() {
  const wiki = (window.WIKI_DATA && typeof window.WIKI_DATA === "object")
    ? window.WIKI_DATA
    : extractObjectFromScripts("WIKI_DATA");
  const show = (window.SHOW_DATA && typeof window.SHOW_DATA === "object")
    ? window.SHOW_DATA
    : extractObjectFromScripts("SHOW_DATA");
  const slug = location.pathname.split("/").filter(Boolean)[0] || "";
  return { wiki, show, slug, url: location.href };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "LSV_CAPTURE_CANON") return false;
  sendResponse(captureCanon());
  return true;
});
