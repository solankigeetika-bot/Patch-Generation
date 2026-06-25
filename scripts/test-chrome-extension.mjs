#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

class MockResponse {
  constructor(body, { status = 200, statusText = "OK" } = {}) {
    this._body = typeof body === "string" ? body : JSON.stringify(body);
    this.status = status;
    this.statusText = statusText;
    this.ok = status >= 200 && status < 300;
  }

  async text() {
    return this._body;
  }

  clone() {
    return new MockResponse(this._body, {
      status: this.status,
      statusText: this.statusText,
    });
  }
}

function makeElement(id) {
  return {
    id,
    value: "",
    textContent: "",
    disabled: false,
    innerHTML: "",
    listeners: {},
    classList: {
      values: new Set(),
      add(name) {
        this.values.add(name);
      },
      remove(name) {
        this.values.delete(name);
      },
      toggle(name, force) {
        if (force) this.values.add(name);
        else this.values.delete(name);
      },
      contains(name) {
        return this.values.has(name);
      },
    },
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
  };
}

const elements = new Map();
const elementIds = [
  "backendUrl", "proxySecret", "saveSettings", "healthBtn", "refreshBtn",
  "loadSheetBtn", "authGoogleBtn", "runAllBtn", "runCultureBtn", "writeBtn",
  "previewReplaceBtn", "applyReplaceBtn", "connectCanonBtn", "sheetStatus",
  "connectionStatus", "runStatus", "sourceLang", "targetLang", "stats",
  "issueCount", "rowCount", "mentionCount", "autoClearedCount", "findings", "replaceFind",
  "replaceWith", "replaceStatus", "canonStatus",
];
for (const id of elementIds) elements.set(id, makeElement(id));
elements.get("sourceLang").value = "German";
elements.get("targetLang").value = "French";

const documentListeners = {};
const tokenCalls = [];
const removedTokens = [];
let clearedTokens = 0;
const fetchCalls = [];
const tabMessages = [];
const storage = {
  backendUrl: "https://confidentiality-latino-nelson-depend.trycloudflare.com",
  proxySecret: "test-secret",
};

const sandbox = {
  console,
  URLSearchParams,
  Headers,
  Set,
  Map,
  RegExp,
  String,
  Number,
  Boolean,
  Promise,
  setTimeout,
  clearTimeout,
  document: {
    addEventListener(type, fn) {
      documentListeners[type] = fn;
    },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
  },
  chrome: {
    runtime: {
      lastError: null,
      getManifest() {
        return {
          oauth2: {
            client_id: "test-client.apps.googleusercontent.com",
            scopes: ["https://www.googleapis.com/auth/spreadsheets"],
          },
        };
      },
    },
    storage: {
      local: {
        get(defaults, cb) {
          cb({ ...defaults, ...storage });
        },
        set(next, cb) {
          Object.assign(storage, next);
          cb();
        },
      },
    },
    identity: {
      getAuthToken(_opts, cb) {
        const token = tokenCalls.length === 0 ? "stale-token" : "fresh-token";
        tokenCalls.push(token);
        sandbox.chrome.runtime.lastError = null;
        cb(token);
      },
      removeCachedAuthToken({ token }, cb) {
        removedTokens.push(token);
        cb();
      },
      clearAllCachedAuthTokens(cb) {
        clearedTokens += 1;
        cb();
      },
      getProfileUserInfo(cb) {
        cb({ email: "solanki.geetika@pocketfm.com" });
      },
    },
    tabs: {
      async query(opts = {}) {
        if (opts.url === "https://canon.pocketfm.ai/*") {
          return [{
            id: 2,
            active: false,
            url: "https://canon.pocketfm.ai/twists-of-love-revenge/",
          }];
        }
        return [{
          id: 1,
          active: true,
          url: "https://docs.google.com/spreadsheets/d/testSheetId/edit?gid=333958024",
        }];
      },
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, message });
        return {
          slug: "twists-of-love-revenge",
          url: "https://canon.pocketfm.ai/twists-of-love-revenge/",
          wiki: { show_title: "Twists of Love & Revenge" },
          show: { title: "Twists of Love & Revenge" },
        };
      },
    },
    scripting: {
      async executeScript() {},
    },
  },
  async fetch(url, options = {}) {
    fetchCalls.push({ url, options });
    const target = String(url);
    if (target.includes("/v4/spreadsheets/testSheetId?")) {
      const sheetsFetches = fetchCalls.filter((call) => String(call.url).includes("/v4/spreadsheets/testSheetId?")).length;
      if (sheetsFetches === 1) {
        return new MockResponse({
          error: { message: "Request had insufficient authentication scopes." },
        }, { status: 403, statusText: "Forbidden" });
      }
      return new MockResponse({
        properties: { title: "TOLR_1-100_Non-reviewed" },
        sheets: [
          { properties: { title: "Localization Details" } },
          { properties: { title: "Mention Mappings" } },
        ],
      });
    }
    if (target.includes("/values:batchGet")) {
      return new MockResponse({
        valueRanges: [
          { values: [
            ["Type", "ID", "Canonical Name", "Original Mention", "Localized Mention", "English Translated Mention", "Gender"],
            ["Character", "char_1", "emily kaiser", "Oma", "Oma", "Grandmother", "Female"],
          ] },
          { values: [
            ["Type", "ID", "Original Name", "Localized Name"],
            ["Character", "char_1", "emily kaiser", "émilie lempereur"],
          ] },
        ],
      });
    }
    if (target === "http://127.0.0.1:8000/health") {
      assert.equal(options.headers["X-Proxy-Secret"], "test-secret");
      assert.equal(options.headers["bypass-tunnel-reminder"], "ls-verifier-agent");
      return new MockResponse({ status: "ok", madeye: true, user_email: true });
    }
    if (target === "http://127.0.0.1:8000/verify-mentions") {
      assert.equal(options.headers["X-Proxy-Secret"], "test-secret");
      assert.equal(options.headers["bypass-tunnel-reminder"], "ls-verifier-agent");
      const payload = JSON.parse(options.body);
      assert.equal(payload.check_mode, "culture");
      assert.equal(payload.user_email, "solanki.geetika@pocketfm.com");
      assert.equal(payload.mm.length, 1);
      return new MockResponse({
        findings: [{
          tab: "Mention Mappings",
          row: 2,
          kind: "TARGET_CULTURE_MISMATCH",
          detail: "Oma is German.",
          suggestion: "Mamie",
          confidence: 90,
        }],
        rowCount: 1,
        mmCount: 1,
        autoCleared: { lowValueEntityRows: 12, sample: [] },
      });
    }
    if (target === "http://127.0.0.1:8000/update-canon-session") {
      assert.equal(options.headers["X-Proxy-Secret"], "test-secret");
      assert.equal(options.headers["bypass-tunnel-reminder"], "ls-verifier-agent");
      const payload = JSON.parse(options.body);
      assert.equal(payload.secret, "test-secret");
      assert.equal(payload.slug, "twists-of-love-revenge");
      assert.equal(payload.wiki.show_title, "Twists of Love & Revenge");
      return new MockResponse({
        ok: true,
        message: "Story Canon connected.",
        slug: "twists-of-love-revenge",
      });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  },
};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync("chrome_extension/sidepanel.js", "utf8"), sandbox);

await documentListeners.DOMContentLoaded();

assert.equal(storage.backendUrl, "http://127.0.0.1:8000");
assert.deepEqual(removedTokens, ["stale-token"]);
assert.deepEqual(tokenCalls, ["stale-token", "fresh-token", "fresh-token"]);
assert.match(elements.get("sheetStatus").textContent, /Loaded TOLR_1-100_Non-reviewed: 1 mention rows/);

await elements.get("healthBtn").listeners.click();
assert.match(elements.get("connectionStatus").textContent, /Backend ok/);

await elements.get("runCultureBtn").listeners.click();
assert.equal(elements.get("issueCount").textContent, "1");
assert.equal(elements.get("autoClearedCount").textContent, "12");
assert.equal(elements.get("writeBtn").disabled, false);
assert.match(elements.get("findings").innerHTML, /TARGET_CULTURE_MISMATCH/);

await elements.get("authGoogleBtn").listeners.click();
assert.equal(clearedTokens, 1);
assert.match(elements.get("sheetStatus").textContent, /Loaded TOLR_1-100_Non-reviewed/);

await elements.get("connectCanonBtn").listeners.click();
assert.equal(JSON.stringify(tabMessages), JSON.stringify([{
  tabId: 2,
  message: { type: "LSV_CAPTURE_CANON" },
}]));
assert.match(elements.get("canonStatus").textContent, /Story Canon connected/);

console.log("chrome extension harness ok");
