/*
 * Two-tier forwarder + policy distribution.
 *
 * TIER 1  ev:*  - metadata only, no prompt bodies. Flushed every ~30s.
 * TIER 2  rv:*  - full text of prompts the local rules could NOT clear.
 *                 Shipped once at end of day, then purged locally.
 *
 * Clean prompts never enter tier 2.
 *
 * STORAGE SHAPE MATTERS. An earlier version kept each tier as a single array
 * under one key, so every new event meant read-whole-array, push, write-whole-
 * array. With a staged spreadsheet paste sitting in that array, each of those
 * round trips re-serialized hundreds of KB. Cost grew with queue size and the
 * user felt it as lag. One key per item makes every write O(1) regardless of
 * what else is queued.
 *
 * WHAT V2 ADDS
 * ------------
 * The worker is now also the policy authority for every content script in the
 * browser. That centralization is deliberate:
 *
 *   - Managed storage reads are cheap but not free, and a content script on
 *     every page in discover mode would do one per navigation. One read here,
 *     cached, invalidated on change.
 *   - Server-pushed policy has to land somewhere that outlives a tab.
 *   - Dynamic content-script registration is a worker-only API, and it is what
 *     lets a new AI site be covered without shipping a build.
 *
 * MV3 EVICTION IS THE HARD PART. Nothing in a module-level variable survives
 * worker teardown. Every cache here is treated as a hint that may be empty on
 * the next message, and every scheduled action is an alarm (which survives)
 * rather than a timer (which does not).
 */

import { DEFAULTS } from "./server-config.js";
import "./browser-compat.js";
import "./sites.js";
import "./policy.js";

const BR = globalThis.DLP_BROWSER;
const api = BR.api;
const P = globalThis.DLP_POLICY;

const EV = "ev:";
const RV = "rv:";
const DISCOVERY_KEY = "discovered";
const POLICY_CACHE_KEY = "policyCache";

function authHeaders(cfg) {
  const h = { "Content-Type": "application/json" };
  if (cfg.token) h["Authorization"] = `Bearer ${cfg.token}`;
  return h;
}

async function config() {
  const managed = await BR.storage.managed.get(null);
  return { ...DEFAULTS, ...managed };
}

/* ---------- policy ----------
 *
 * Three sources, merged in ascending precedence:
 *
 *   1. DEFAULT_POLICY in policy.js -- compiled in, always present.
 *   2. Managed storage -- the GPO / plist / JSON the endpoint team controls.
 *      Authoritative for anything IT considers non-negotiable.
 *   3. Server push, cached in local storage -- how compliance responds to an
 *      incident in minutes instead of waiting on a policy refresh cycle.
 *
 * Server-pushed policy is deliberately NOT allowed to widen coverage or lower
 * enforcement below what managed policy set. A compromised or misconfigured
 * server should not be able to silently disable DLP across the fleet, and the
 * asymmetry (can tighten, cannot loosen) is what makes the push channel safe
 * enough to have at all. See clampToManaged().
 */

let policyCache = null;
let policyCacheAt = 0;
const POLICY_TTL = 60 * 1000;

function clampToManaged(managed, pushed) {
  if (!pushed) return null;
  const out = { ...pushed };

  // Mode floors: the server may raise enforcement, never lower it.
  const floor = P.normalizeMode(managed.defaultMode);
  if (floor && !P.atLeast(P.normalizeMode(out.defaultMode) || "off", floor)) {
    delete out.defaultMode;
  }
  if (managed.categoryModes && out.categoryModes) {
    for (const [cat, m] of Object.entries(out.categoryModes)) {
      const mf = P.normalizeMode(managed.categoryModes[cat]);
      if (mf && !P.atLeast(P.normalizeMode(m) || "off", mf)) delete out.categoryModes[cat];
    }
  }

  // The server may ADD exemptions only if managed policy allows it. Default
  // is no: a rule exemption is the one control that turns detection off, and
  // the ability to push one remotely is the ability to blind the tool.
  if (!managed.allowServerExemptions) {
    delete out.exemptRules;
    delete out.exemptRulesBySite;
  }
  // Never let a push remove sites from coverage or shrink neverScan handling.
  delete out.disabledSites;
  delete out.neverScan;
  return out;
}

async function resolvePolicy(force = false) {
  const now = Date.now();
  if (!force && policyCache && now - policyCacheAt < POLICY_TTL) return policyCache;

  const managed = await BR.storage.managed.get(null);
  const local = await BR.storage.local.get(POLICY_CACHE_KEY);
  const pushed = clampToManaged(managed || {}, local?.[POLICY_CACHE_KEY]?.policy);

  policyCache = P.mergePolicy(managed, pushed);
  policyCacheAt = now;
  return policyCache;
}

api.storage.onChanged.addListener((changes, area) => {
  if (area === "managed" || changes[POLICY_CACHE_KEY]) {
    policyCache = null;
    syncRegistrations().catch(() => {});
  }
});

/* ---------- dynamic content script registration ----------
 *
 * The manifest ships the catalog as a static match list, which is the floor:
 * it works with zero configuration and on browsers too old for the scripting
 * API. Everything ABOVE that floor -- policy-added sites, discover-mode
 * coverage -- is registered here at runtime.
 *
 * Two registrations, not one, because they have different match sets and
 * different failure modes:
 *
 *   dlp-catalog   policy extraSites. Narrow, always safe to register.
 *   dlp-discover  <all_urls>. Only when coverage=discover AND the permission
 *                 was actually granted. Registering a match pattern the
 *                 extension has no host permission for throws, and on Firefox
 *                 MV3 host permissions are OPTIONAL by default -- the user (or
 *                 a force_installed policy) has to grant them. So check first.
 */

const DISCOVER_SCRIPT_ID = "dlp-discover";
const CATALOG_SCRIPT_ID = "dlp-catalog";
const SCRIPT_FILES = [
  "browser-compat.js", "sites.js", "policy.js", "discovery.js",
  "rules.js", "content.js",
];

async function syncRegistrations() {
  if (!BR.scripting?.registerContentScripts) return; // old browser: manifest floor only
  const policy = await resolvePolicy(true);

  const existing = await BR.scripting
    .getRegisteredContentScripts()
    .catch(() => []);
  const have = new Set(existing.map((s) => s.id));

  // --- policy-added catalog sites ---
  const extra = policy.extraSites || [];
  const patterns = globalThis.DLP_SITES.toMatchPatterns(extra);
  await unregister(CATALOG_SCRIPT_ID, have);
  if (patterns.length) {
    const granted = [];
    for (const pat of patterns) {
      if (await BR.hasHostAccess(pat)) granted.push(pat);
    }
    if (granted.length) {
      await register({
        id: CATALOG_SCRIPT_ID,
        matches: granted,
        js: SCRIPT_FILES,
        runAt: "document_start",
        allFrames: true,
      });
    }
    // A pattern we do not hold permission for is not an error to swallow
    // silently -- it is the single most common reason "the extension does
    // nothing on that site". Record it so it shows up in the report.
    const missing = patterns.filter((p) => !granted.includes(p));
    if (missing.length) await recordGap(`no host permission for ${missing.join(", ")}`);
  }

  // --- discover mode ---
  await unregister(DISCOVER_SCRIPT_ID, have);
  if (policy.coverage === "discover") {
    const ok = await BR.hasHostAccess("https://*/*");
    if (ok) {
      await register({
        id: DISCOVER_SCRIPT_ID,
        matches: ["https://*/*"],
        // Discovery excludes are a performance decision as much as a privacy
        // one: these are high-traffic origins that are never AI surfaces, and
        // not running there keeps the fleet-wide cost of discover mode low.
        excludeMatches: [
          "https://*.google.com/search*",
          "https://*.googleapis.com/*",
          "https://*.gstatic.com/*",
          "https://*.doubleclick.net/*",
        ],
        js: SCRIPT_FILES,
        runAt: "document_start",
        allFrames: false, // top frame only; ad iframes are pure overhead here
      });
    } else {
      await recordGap("coverage=discover but broad host permission not granted");
    }
  }
}

async function register(spec) {
  try {
    await BR.scripting.registerContentScripts([spec]);
  } catch (e) {
    await recordGap(`registerContentScripts(${spec.id}) failed: ${e.message}`);
  }
}

async function unregister(id, have) {
  if (!have.has(id)) return;
  try {
    await BR.scripting.unregisterContentScripts({ ids: [id] });
  } catch (_) {}
}

async function recordGap(note) {
  await BR.storage.local.set({
    [newKey(EV)]: {
      site: "-", source: "system", severity: "gap",
      engine: BR.ENGINE, note, ts: new Date().toISOString(),
    },
  });
}

function newKey(prefix) {
  return prefix + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

async function readPrefix(prefix, cap) {
  const all = await BR.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(prefix)).sort();
  const trimmed = cap && keys.length > cap ? keys.slice(-cap) : keys;
  return { keys: trimmed, items: trimmed.map((k) => all[k]) };
}

/* ---------- attribution ---------- */

/* Who was at the keyboard. Resolution order:
 *   1. workstationTag from managed policy -- IT sets this per machine, works
 *      on Chrome, Edge, AND Firefox, and survives profile weirdness. Preferred.
 *   2. Chrome profile email, best effort. Empty on unmanaged/unsigned profiles,
 *      unreliable on Edge, and ABSENT ENTIRELY on Firefox -- chrome.identity
 *      .getProfileUserInfo does not exist there. That is why 1 is preferred and
 *      why this whole chain is wrapped: on Firefox v1 threw here on every
 *      event, and the catch made it look like attribution simply never
 *      resolved rather than like an unsupported API.
 *   3. "unattributed" -- never block the pipeline on identity.
 *
 * Deliberate scope: identity is stamped ONLY on flagged/override events and
 * staged tier-2 items. Clean prompts stay anonymous. Attribution exists so the
 * compliance team can act on an incident, not so anyone can browse an
 * employee's LLM usage. Widening this is a policy decision, not a code tweak.
 */
let cachedUser = null;

async function resolveEmployee() {
  if (cachedUser) return cachedUser;
  try {
    const managed = await BR.storage.managed.get("workstationTag");
    if (managed?.workstationTag) return (cachedUser = String(managed.workstationTag));
  } catch (_) {}
  try {
    if (BR.identity?.getProfileUserInfo) {
      const info = await BR.promisify(
        BR.identity.getProfileUserInfo, BR.identity
      )({ accountStatus: "ANY" });
      if (info?.email) return (cachedUser = info.email);
    }
  } catch (_) {}
  return (cachedUser = "unattributed");
}

/* ---------- intake ---------- */

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Policy request from a content script. MUST return true synchronously to
  // keep the message channel open for the async reply -- returning a promise
  // works on Firefox but not on Chrome, and getting this wrong means every
  // content script silently falls back to defaults.
  if (msg?.type === "getPolicy") {
    resolvePolicy()
      .then((policy) => sendResponse({ policy }))
      .catch(() => sendResponse({ policy: null }));
    return true;
  }

  if (msg?.type === "event") {
    (async () => {
      const payload = { ...msg.payload, employee: await resolveEmployee() };
      await BR.storage.local.set({ [newKey(EV)]: payload });
    })();
  }

  if (msg?.type === "stage") {
    (async () => {
      const policy = await resolvePolicy();
      // Monitor-mode sites still stage: the whole point of monitor is to build
      // the evidence base that tells you whether to enforce. What monitor does
      // NOT do is interrupt the user.
      if (policy.stageMode === "flagged-only" && msg.payload?.severity === "clean") return;
      const payload = { ...msg.payload, employee: await resolveEmployee() };
      await BR.storage.local.set({ [newKey(RV)]: payload });
    })();
  }

  if (msg?.type === "presence") {
    (async () => {
      await BR.storage.local.set({ [newKey(EV)]: { ...msg.payload, severity: "presence" } });
    })();
  }

  // Discovery hits are deduplicated locally by host so one employee browsing a
  // chat site all day produces one finding, not four hundred.
  if (msg?.type === "discovery") {
    (async () => {
      const store = (await BR.storage.local.get(DISCOVERY_KEY))?.[DISCOVERY_KEY] || {};
      const prev = store[msg.payload.site];
      const today = new Date().toISOString().slice(0, 10);
      if (prev?.day === today) {
        prev.hits = (prev.hits || 1) + 1;
      } else {
        store[msg.payload.site] = {
          day: today, hits: 1, title: msg.payload.title,
          score: msg.payload.score, signals: msg.payload.signals,
        };
        await BR.storage.local.set({
          [newKey(EV)]: {
            ...msg.payload,
            severity: "discovery",
            employee: await resolveEmployee(),
          },
        });
      }
      await BR.storage.local.set({ [DISCOVERY_KEY]: store });
    })();
  }
});

/* ---------- scheduling ---------- */

function nextLocal(hour, minute) {
  const now = new Date();
  const t = new Date(now);
  t.setHours(hour, minute, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t.getTime();
}

async function scheduleAll() {
  const cfg = await config();
  api.alarms.create("flushEvents", {
    periodInMinutes: Math.max(cfg.flushSeconds / 60, 0.5),
  });
  api.alarms.create("eodReview", {
    when: nextLocal(cfg.eodHour, cfg.eodMinute),
    periodInMinutes: 1440,
  });
  // Policy refresh. Managed storage fires onChanged, but a server push has no
  // event to hang off, so poll. Hourly is well inside the window where an
  // incident response is still considered same-day.
  api.alarms.create("policyPull", { periodInMinutes: cfg.policyPullMinutes || 60 });
}

api.runtime.onInstalled.addListener(async () => {
  await scheduleAll();
  await syncRegistrations();
});

api.runtime.onStartup.addListener(async () => {
  await scheduleAll();
  await syncRegistrations();
  await catchUp();
});

api.alarms.onAlarm.addListener((a) => {
  if (a.name === "flushEvents") flushEvents();
  if (a.name === "eodReview") runEndOfDay("scheduled");
  if (a.name === "policyPull") pullPolicy();
});

api.idle.setDetectionInterval(15 * 60);
api.idle.onStateChanged.addListener((state) => {
  if (state === "locked") runEndOfDay("session-lock");
});

/* ---------- policy pull ---------- */

async function pullPolicy() {
  const cfg = await config();
  if (!cfg.policyEndpoint) return;
  try {
    const res = await fetch(cfg.policyEndpoint, {
      method: "GET",
      headers: authHeaders(cfg),
    });
    if (!res.ok) return;
    const body = await res.json();
    if (!body || typeof body !== "object" || !body.policy) return;
    await BR.storage.local.set({
      [POLICY_CACHE_KEY]: { policy: body.policy, version: body.version, at: Date.now() },
    });
    policyCache = null;
    await syncRegistrations();
  } catch (_) {
    // A server that cannot be reached leaves the last-known policy in place.
    // Falling back to defaults on a network blip would silently change
    // enforcement across the fleet every time the VPN hiccuped.
  }
}

/* ---------- tier 1 ---------- */

async function flushEvents() {
  const cfg = await config();
  const { keys, items } = await readPrefix(EV, cfg.maxQueue);
  if (!items.length) return;

  try {
    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: authHeaders(cfg),
      body: JSON.stringify({
        agentVersion: api.runtime.getManifest().version,
        engine: BR.ENGINE,
        events: items,
      }),
    });
    if (res.ok) await BR.storage.local.remove(keys);
  } catch (_) {
    /* keep and retry next alarm */
  }
}

/* ---------- tier 2 ---------- */

async function runEndOfDay(trigger) {
  const cfg = await config();
  await purgeStale(cfg);

  const { keys, items } = await readPrefix(RV, cfg.maxReviewItems);
  if (!items.length) return;

  try {
    const res = await fetch(cfg.reviewEndpoint, {
      method: "POST",
      headers: authHeaders(cfg),
      body: JSON.stringify({
        agentVersion: api.runtime.getManifest().version,
        engine: BR.ENGINE,
        batchId: crypto.randomUUID(),
        trigger,
        closedAt: new Date().toISOString(),
        itemCount: items.length,
        items,
      }),
    });
    if (res.ok) {
      // Purge only on confirmed receipt.
      await BR.storage.local.remove(keys);
      await BR.storage.local.set({ lastBatchAt: Date.now() });
    }
  } catch (_) {
    /* retry at next trigger */
  }
  await flushEvents();
}

async function catchUp() {
  const { items } = await readPrefix(RV);
  if (items.length) await runEndOfDay("startup-catchup");
}

async function purgeStale(cfg) {
  const all = await BR.storage.local.get(null);
  const cutoff = Date.now() - cfg.maxStageAgeHours * 3600 * 1000;
  const stale = Object.keys(all).filter(
    (k) => k.startsWith(RV) && new Date(all[k].ts).getTime() < cutoff
  );
  if (!stale.length) return;

  await BR.storage.local.remove(stale);
  await recordGap(`purged ${stale.length} staged items past retention`);
}
