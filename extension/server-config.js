/*
 * DEV DEFAULTS -- committed so `extension/` loads unpacked with no build step.
 *
 * background.js does a STATIC import of this file. A static import of a
 * missing module kills the service worker before any of its code runs, so a
 * gitignored server-config.js meant a fresh clone produced an extension that
 * loaded and then did nothing, with the only clue buried in the worker console.
 * Committing a placeholder is worth more than the tidiness of ignoring it.
 *
 * The token here is a PLACEHOLDER, not a secret. In production the endpoint
 * and token come from managed policy (see enterprise/samples/), which
 * overrides everything in this file -- so IT repoints the fleet without
 * touching a build. Do not paste a real token here on a shared machine.
 *
 * The one file you edit when the server moves.
 *
 * Local testing:  http://127.0.0.1:8787
 * Production:     https://dlp.internal.fortbendcountytx.gov
 *
 * Whatever base you set here must ALSO appear in manifest.json under
 * host_permissions, or the service worker's fetch is blocked and events pile up
 * silently in local storage. That silence is the #1 way this looks broken.
 *
 * In production these values are overridden by Chrome managed policy
 * (policy_schema.json), so IT can repoint the fleet without shipping a new
 * build. This file is the fallback for dev and for unmanaged machines.
 */

export const SERVER = {
  base: "http://127.0.0.1:8787",

  // Shared token. A deployment stopgap so a random host on the LAN cannot
  // inject fake events -- NOT real authentication. Move to mTLS or device
  // certs before this leaves pilot. Must match DLP_TOKEN on the server.
  token: "dev-token-change-me",
};

export const DEFAULTS = {
  endpoint: `${SERVER.base}/api/events`,
  reviewEndpoint: `${SERVER.base}/api/review-batch`,

  // Optional. When set, the worker pulls fleet policy from the server hourly
  // so a new AI site can be covered without waiting on a GPO refresh cycle.
  // Empty means managed policy (or compiled-in defaults) only -- which is the
  // right choice if you would rather every policy change go through AD.
  //
  // Anything arriving here is clamped: it can tighten enforcement, never
  // loosen it. See clampToManaged() in background.js.
  policyEndpoint: "",
  policyPullMinutes: 60,

  token: SERVER.token,
  flushSeconds: 30,
  eodHour: 17,
  eodMinute: 30,
  maxQueue: 500,
  maxReviewItems: 300,
  maxStageAgeHours: 72,
};
