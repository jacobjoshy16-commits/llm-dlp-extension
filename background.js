/*
 * Two-tier forwarder.
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
 */

import { DEFAULTS } from "./server-config.js";

const EV = "ev:";
const RV = "rv:";

function authHeaders(cfg) {
  const h = { "Content-Type": "application/json" };
  if (cfg.token) h["Authorization"] = `Bearer ${cfg.token}`;
  return h;
}

async function config() {
  const managed = await chrome.storage.managed.get(null).catch(() => ({}));
  return { ...DEFAULTS, ...managed };
}

function newKey(prefix) {
  return prefix + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

async function readPrefix(prefix, cap) {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(prefix)).sort();
  const trimmed = cap && keys.length > cap ? keys.slice(-cap) : keys;
  return { keys: trimmed, items: trimmed.map((k) => all[k]) };
}

/* ---------- attribution ---------- */

/* Who was at the keyboard. Resolution order:
 *   1. workstationTag from managed policy -- IT sets this per machine, works
 *      on both Chrome and Edge, and survives profile weirdness. Preferred.
 *   2. Chrome profile email, best effort. Empty on unmanaged/unsigned profiles
 *      and unreliable on Edge.
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
    const managed = await chrome.storage.managed.get("workstationTag");
    if (managed?.workstationTag) return (cachedUser = String(managed.workstationTag));
  } catch (_) {}
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    if (info?.email) return (cachedUser = info.email);
  } catch (_) {}
  return (cachedUser = "unattributed");
}

/* ---------- intake ---------- */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "event") {
    (async () => {
      const payload = { ...msg.payload, employee: await resolveEmployee() };
      await chrome.storage.local.set({ [newKey(EV)]: payload });
    })();
  }
  if (msg?.type === "stage") {
    (async () => {
      const payload = { ...msg.payload, employee: await resolveEmployee() };
      await chrome.storage.local.set({ [newKey(RV)]: payload });
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
  chrome.alarms.create("flushEvents", {
    periodInMinutes: Math.max(cfg.flushSeconds / 60, 0.5),
  });
  chrome.alarms.create("eodReview", {
    when: nextLocal(cfg.eodHour, cfg.eodMinute),
    periodInMinutes: 1440,
  });
}

chrome.runtime.onInstalled.addListener(scheduleAll);
chrome.runtime.onStartup.addListener(async () => {
  await scheduleAll();
  await catchUp();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "flushEvents") flushEvents();
  if (a.name === "eodReview") runEndOfDay("scheduled");
});

chrome.idle.setDetectionInterval(15 * 60);
chrome.idle.onStateChanged.addListener((state) => {
  if (state === "locked") runEndOfDay("session-lock");
});

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
        agentVersion: chrome.runtime.getManifest().version,
        events: items,
      }),
    });
    if (res.ok) await chrome.storage.local.remove(keys);
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
        agentVersion: chrome.runtime.getManifest().version,
        batchId: crypto.randomUUID(),
        trigger,
        closedAt: new Date().toISOString(),
        itemCount: items.length,
        items,
      }),
    });
    if (res.ok) {
      // Purge only on confirmed receipt.
      await chrome.storage.local.remove(keys);
      await chrome.storage.local.set({ lastBatchAt: Date.now() });
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
  const all = await chrome.storage.local.get(null);
  const cutoff = Date.now() - cfg.maxStageAgeHours * 3600 * 1000;
  const stale = Object.keys(all).filter(
    (k) => k.startsWith(RV) && new Date(all[k].ts).getTime() < cutoff
  );
  if (!stale.length) return;

  await chrome.storage.local.remove(stale);
  await chrome.storage.local.set({
    [newKey(EV)]: {
      site: "-",
      source: "system",
      severity: "gap",
      note: `purged ${stale.length} staged items past retention`,
      ts: new Date().toISOString(),
    },
  });
}
