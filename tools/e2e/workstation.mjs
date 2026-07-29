/*
 * A simulated workstation.
 *
 * This is NOT a mock of the extension. It loads the REAL content scripts and
 * the REAL background service worker out of extension/, and drives them the
 * way a browser and a user would. The only things faked are the browser itself
 * (a chrome.* stub over an in-memory storage area) and the DOM.
 *
 * That distinction is the whole point of the exercise. A harness that
 * reimplements the extension's logic proves the harness works. This one can
 * fail because the extension is broken -- which is what an end-to-end test is
 * for.
 *
 * WHAT IS REAL
 *   rules.js, sites.js, policy.js, conversation.js  loaded verbatim in a vm
 *   background.js                                   imported as a real ES module
 *   the decision path                               scan -> policy -> context
 *   the network                                     genuine fetch() to uvicorn
 *   storage semantics                               one key per item, prefix scans
 *
 * WHAT IS FAKED
 *   chrome.*        in-memory storage, alarm/idle triggers we fire by hand
 *   the DOM         no composer; text is handed straight to the decision path
 *   the clock       alarms are invoked explicitly instead of on a timer
 */

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, resolve } from "node:path";

export class Workstation {
  static _lock = Promise.resolve();

  constructor({ id, employee, engine = "chrome", extDir, endpointBase, token, policy = {} }) {
    this.id = id;
    this.employee = employee;
    this.engine = engine;
    this.extDir = extDir;
    this.endpointBase = endpointBase;
    this.token = token;
    this.managedPolicy = policy;
    this.storage = new Map();
    this.listeners = { message: [], alarm: [], idle: [], startup: [], installed: [] };
    this.alarms = new Map();
    this.sent = { events: 0, staged: 0 };
    this.chrome = null; // built once in _chrome(), reused for this box
  }

  /* ---------- chrome.* stub ----------
   *
   * Storage is a flat Map, matching chrome.storage.local's actual shape. The
   * background worker's readPrefix() does get(null) then filters by key
   * prefix, so this has to behave like a real key/value area, not like a
   * convenience wrapper.
   */
  _chrome() {
    // Memoized. background.js captures the namespace at module scope via
    // browser-compat.js, so handing out a fresh object per call would leave
    // the worker writing into a storage area nobody reads.
    if (this.chrome) return this.chrome;
    const store = this.storage;
    const managed = this.managedPolicy;
    const L = this.listeners;

    const local = {
      get: async (k) => {
        if (k === null || k === undefined) return Object.fromEntries(store);
        if (typeof k === "string") return store.has(k) ? { [k]: store.get(k) } : {};
        if (Array.isArray(k)) {
          const out = {};
          for (const key of k) if (store.has(key)) out[key] = store.get(key);
          return out;
        }
        return {};
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
      remove: async (keys) => { for (const k of [].concat(keys)) store.delete(k); },
    };

    const api = {
      runtime: {
        getManifest: () => ({ version: "0.2.0", manifest_version: 3 }),
        sendMessage: async (msg) => {
          // Deliver synchronously to every registered listener, as the real
          // dispatcher does within a single extension process.
          for (const fn of L.message) {
            try { fn(msg, { id: this.id }, () => {}); } catch (e) { this.lastError = e; }
          }
        },
        onMessage: { addListener: (fn) => L.message.push(fn) },
        onStartup: { addListener: (fn) => L.startup.push(fn) },
        onInstalled: { addListener: (fn) => L.installed.push(fn) },
        lastError: null,
      },
      storage: {
        local,
        managed: { get: async (k) => (k === null ? managed : (managed[k] !== undefined ? { [k]: managed[k] } : {})) },
        onChanged: { addListener: () => {} },
      },
      alarms: {
        create: (name, opts) => this.alarms.set(name, opts),
        onAlarm: { addListener: (fn) => L.alarm.push(fn) },
      },
      idle: {
        setDetectionInterval: () => {},
        onStateChanged: { addListener: (fn) => L.idle.push(fn) },
      },
      permissions: { contains: async () => true },
      scripting: {
        registerContentScripts: async () => {},
        unregisterContentScripts: async () => {},
        getRegisteredContentScripts: async () => [],
      },
      identity: null, // matches Firefox; forces workstationTag attribution
    };
    this.chrome = api;
    return api;
  }

  /* ---------- content-script world ----------
   *
   * vm.createContext reproduces Chrome's isolated world: each file is a
   * separate top-level script sharing one global, top-level const stays in
   * script scope. This is the harness that caught DLP_RULES never reaching
   * globalThis, so it is worth keeping honest here too.
   */
  loadContentScripts() {
    const files = ["browser-compat.js", "sites.js", "policy.js", "discovery.js",
                   "rules.js", "conversation.js"];
    const ctx = createContext({
      console,
      performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 },
      setTimeout, clearTimeout, structuredClone,
      navigator: { userAgent: this.engine === "firefox" ? "Firefox/128.0" : "Chrome/121" },
      document: {
        querySelectorAll: () => [], querySelector: () => null,
        addEventListener: () => {}, documentElement: {}, title: "",
      },
      location: { hostname: "chatgpt.com", pathname: "/" },
      MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
      chrome: this._chrome(),
    });
    for (const f of files) {
      runInContext(readFileSync(join(this.extDir, f), "utf8"), ctx, { filename: f });
    }
    this.world = ctx;
    this.api = runInContext(
      "({R:globalThis.DLP_RULES,P:globalThis.DLP_POLICY,C:globalThis.DLP_CONTEXT,S:globalThis.DLP_SITES})",
      ctx
    );
    if (!this.api.R || !this.api.P || !this.api.C) {
      throw new Error(`${this.id}: content scripts did not publish their globals`);
    }
    return this;
  }

  /* ---------- background worker ----------
   *
   * Imported as a genuine ES module so its top-level side effects -- alarm
   * creation, listener registration -- actually run. globalThis.chrome must be
   * in place first, because browser-compat.js reads it at module scope.
   *
   * A cache-busting query keeps each workstation's worker a separate module
   * instance; without it Node would hand every workstation the same singleton
   * and they would share the module-level policy cache.
   */
  async loadWorker() {
    globalThis.chrome = this._chrome();
    // Node 22 defines a getter-only `navigator`, so plain assignment throws.
    // browser-compat.js reads navigator.userAgent at module scope to pick the
    // engine, so it has to be overridable here.
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: this.engine === "firefox" ? "Firefox/128.0" : "Chrome/121" },
      configurable: true, writable: true,
    });
    /* Each workstation needs its OWN module instance.
     *
     * A `?ws=` cache-buster on background.js is not enough: its static imports
     * of browser-compat.js / sites.js / policy.js carry no query, so every
     * workstation shares one instance of those -- including the memoized
     * `api` in browser-compat, which captures globalThis.chrome at module
     * scope. The second box then writes into the first box's storage, which
     * looked exactly like "only WS-101 reports".
     *
     * Copying the whole extension into a per-workstation temp dir gives each
     * one a distinct module graph, which is what separate browser processes
     * have in reality.
     */
    const { pathToFileURL } = await import("node:url");
    const { mkdtempSync, cpSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    this.runDir = mkdtempSync(join(tmpdir(), `ws-${this.id}-`));
    cpSync(resolve(this.extDir), this.runDir, { recursive: true });
    await import(pathToFileURL(join(this.runDir, "background.js")).href);
    for (const fn of this.listeners.installed) await fn();
    return this;
  }

  /* Make this workstation's browser the ambient one, for the duration of one
   * critical section.
   *
   * Node has a single global, so N "machines" in one process must take turns.
   * An earlier version just assigned globalThis.chrome and returned -- which is
   * correct only until two boxes act concurrently. Then box A sets the global,
   * awaits, box B overwrites it mid-await, and A's events land in B's storage.
   * In a 3-box test that is invisible; at 12 boxes it showed up as "only 3 of
   * 12 workstations attributed", which reads exactly like an extension bug.
   *
   * A real fleet has one process per box and no such coupling. So serialize
   * the ambient-global sections here: the harness takes turns, while the
   * WORK -- scanning, policy, fetch -- still overlaps, which is the part the
   * concurrency test is actually about.
   */
  async withBrowser(fn) {
    const prev = Workstation._lock;
    let release;
    Workstation._lock = new Promise((r) => (release = r));
    await prev;
    try {
      globalThis.chrome = this._chrome();
      return await fn();
    } finally {
      release();
    }
  }

  /* Synchronous variant for entry points that do not await. */
  activate() {
    globalThis.chrome = this._chrome();
    return this;
  }

  /* ---------- user actions ---------- */

  async resolvePolicy() {
    const merged = this.api.P.mergePolicy(this.managedPolicy);
    return merged;
  }

  /* One prompt submission. Mirrors gate() in content.js: per-message scan,
   * policy decision, then context ONLY when the message itself allows. */
  async submit(text, opts = {}) {
    return this.withBrowser(() => this._submit(text, opts));
  }

  async _submit(text, { site = "chatgpt.com", path = "/", source = "submit" } = {}) {
    const { R, P, C } = this.api;
    const policy = await this.resolvePolicy();
    const r = P.resolve(policy, site, path);
    if (!r.scan) return { action: "not-scanned", reason: r.reason, site };

    const findings = R.scan(text);
    let d = P.decide(r.mode, findings, r.exempt);
    let via = "message";

    if (d.action === "allow" && policy.contextMode && policy.contextMode !== "off") {
      const extra = C.assess(text);
      if (extra.length) {
        const capped = policy.contextMode === "enforce"
          ? extra
          : extra.map((f) => (f.severity === "block" ? { ...f, severity: "warn" } : f));
        d = P.decide(r.mode, [...d.findings, ...capped], r.exempt);
        via = "context";
      }
    }
    C.noteSubmission(text, d.action, d.findings);

    const hash = await sha256(text);
    const ts = new Date().toISOString();

    await globalThis.chrome.runtime.sendMessage({
      type: "event",
      payload: {
        site, siteId: r.siteId, siteName: r.siteName, category: r.category,
        mode: r.mode, action: d.action, discovered: false, engine: this.engine,
        exemptCount: d.exemptCount, source, severity: worst(d.findings),
        charCount: text.length, promptHash: hash,
        findings: d.findings.map(({ id, label, severity, sample, exempt }) =>
          ({ id, label, severity, sample, exempt: !!exempt })),
        ts, employee: this.employee,
      },
    });
    this.sent.events++;

    await globalThis.chrome.runtime.sendMessage({
      type: "stage",
      payload: {
        site, siteId: r.siteId, siteName: r.siteName, category: r.category,
        mode: r.mode, source, severity: worst(d.findings), promptHash: hash,
        fullLength: text.length, truncated: false, text, ts, employee: this.employee,
        findings: d.findings.map(({ id, label, severity }) => ({ id, label, severity })),
      },
    });
    this.sent.staged++;

    return { action: d.action, via, findings: d.findings, site, siteId: r.siteId, mode: r.mode };
  }

  /* User clicks "Send anyway" on a warn. */
  async override(text, site = "chatgpt.com") {
    return this.withBrowser(async () => {
    await globalThis.chrome.runtime.sendMessage({
      type: "event",
      payload: {
        site, source: "override", severity: "override", action: "override",
        engine: this.engine, promptHash: await sha256(text),
        ts: new Date().toISOString(), employee: this.employee,
      },
    });
    this.sent.events++;
    });
  }

  /* ---------- clock ---------- */

  async fireAlarm(name) {
    return this.withBrowser(async () => {
      for (const fn of this.listeners.alarm) await fn({ name });
      await settle();
    });
  }

  async lockWorkstation() {
    return this.withBrowser(async () => {
      for (const fn of this.listeners.idle) await fn("locked");
      await settle();
    });
  }

  queueDepth() {
    let ev = 0, rv = 0;
    for (const k of this.storage.keys()) {
      if (k.startsWith("ev:")) ev++;
      if (k.startsWith("rv:")) rv++;
    }
    return { ev, rv };
  }
}

function worst(findings) {
  if (findings.some((f) => f.severity === "block" && !f.exempt)) return "block";
  if (findings.some((f) => !f.exempt)) return "warn";
  return "clean";
}

async function sha256(str) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(str).digest("hex");
}

/* Let queued microtasks and in-flight fetches drain. The worker's message
 * handlers are fire-and-forget async IIFEs, exactly as in the real extension,
 * so there is nothing to await -- the real browser has the same property. */
export function settle(ms = 120) {
  return new Promise((r) => setTimeout(r, ms));
}
