/*
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
  token: SERVER.token,
  flushSeconds: 30,
  eodHour: 17,
  eodMinute: 30,
  maxQueue: 500,
  maxReviewItems: 300,
  maxStageAgeHours: 72,
};
