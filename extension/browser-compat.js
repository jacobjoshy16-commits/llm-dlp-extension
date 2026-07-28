/*
 * Cross-browser surface.
 *
 * v1 called chrome.* directly. That works on Chrome and Edge and silently
 * throws on Firefox for three APIs the extension depends on. At enterprise
 * scale "silently throws" means one browser in the fleet reports nothing and
 * nobody notices until an audit asks why Firefox workstations produced zero
 * events for a year.
 *
 * Three real differences, not stylistic ones:
 *
 *   1. Namespace. Firefox and Safari expose `browser`; Chrome/Edge expose
 *      `chrome`. Chrome 121+ does not define `browser`, so feature-detect.
 *
 *   2. chrome.identity.getProfileUserInfo does not exist outside Chrome/Edge.
 *      Attribution has to fall back to managed policy, which is the preferred
 *      source anyway -- see resolveEmployee() in background.js.
 *
 *   3. Background type. Firefox MV3 has no service worker; it uses an event
 *      page (`background.scripts`). This file must therefore work when loaded
 *      as a classic script, an ES module import, and a content script. It sets
 *      a global and exports nothing.
 *
 * Also handles the MV3 "no persistent globals" reality: anything cached in a
 * module-level variable can vanish when the worker is evicted, so callers must
 * treat this as a convenience wrapper, not a state store.
 */

(() => {
  "use strict";

  const api = typeof browser !== "undefined" && browser?.runtime ? browser : chrome;

  const ENGINE = (() => {
    if (typeof navigator === "undefined") return "unknown";
    const ua = navigator.userAgent || "";
    if (/Edg\//.test(ua)) return "edge";
    if (/Firefox\//.test(ua)) return "firefox";
    if (/OPR\//.test(ua)) return "opera";
    if (/Brave\//.test(ua) || navigator.brave) return "brave";
    if (/Vivaldi/.test(ua)) return "vivaldi";
    if (/Chrome\//.test(ua)) return "chrome";
    if (/Safari\//.test(ua)) return "safari";
    return "unknown";
  })();

  /* Promise-normalized wrappers.
   *
   * Firefox returns promises; Chrome MV3 also returns promises for most APIs
   * but NOT for every callback form, and Safari lags both. Wrapping once here
   * means no call site has to know which.
   */
  function promisify(fn, thisArg) {
    return (...args) =>
      new Promise((resolve, reject) => {
        try {
          const maybe = fn.apply(thisArg, args);
          if (maybe && typeof maybe.then === "function") {
            maybe.then(resolve, reject);
            return;
          }
          fn.apply(thisArg, [
            ...args,
            (res) => {
              const err = api.runtime?.lastError;
              if (err) reject(new Error(err.message));
              else resolve(res);
            },
          ]);
        } catch (e) {
          reject(e);
        }
      });
  }

  const storage = {
    local: {
      get: (k) => promisify(api.storage.local.get, api.storage.local)(k),
      set: (o) => promisify(api.storage.local.set, api.storage.local)(o),
      remove: (k) => promisify(api.storage.local.remove, api.storage.local)(k),
    },
    // Not every browser/profile has managed storage configured. A rejected
    // promise here is normal, not an error condition -- an unmanaged machine
    // simply has no policy. Callers get {} and fall back to DEFAULTS.
    managed: {
      get: async (k) => {
        try {
          return (await promisify(api.storage.managed.get, api.storage.managed)(k)) || {};
        } catch (_) {
          return {};
        }
      },
    },
    onChanged: api.storage.onChanged,
  };

  /* Dynamic content-script registration.
   *
   * This is what lets a policy update cover a new AI site without shipping a
   * new build. chrome.scripting.registerContentScripts exists in Chrome 96+,
   * Edge 96+, and Firefox 128+. On anything older the extension still works --
   * it just covers only what the manifest declared, which is why the build
   * bakes the catalog into the manifest as a floor.
   */
  const scripting = api.scripting || null;

  async function hasHostAccess(origin) {
    if (!api.permissions?.contains) return true;
    try {
      return await promisify(api.permissions.contains, api.permissions)({ origins: [origin] });
    } catch (_) {
      return false;
    }
  }

  globalThis.DLP_BROWSER = {
    api,
    ENGINE,
    storage,
    scripting,
    hasHostAccess,
    promisify,
    runtime: api.runtime,
    alarms: api.alarms,
    idle: api.idle,
    identity: api.identity || null,
    isFirefox: ENGINE === "firefox",
    isChromium: ["chrome", "edge", "brave", "opera", "vivaldi"].includes(ENGINE),
    manifestVersion: api.runtime?.getManifest?.()?.manifest_version ?? 3,
  };
})();
