/*
 * context_extractor.js
 *
 * Reads the last N rendered conversation turns from the page so the
 * compliance pipeline has surrounding context, not just the text currently
 * sitting in the composer.
 *
 * DESIGN CONSTRAINT -- read before touching BUILTIN_PROFILES.
 *
 * Every AI chat site rewrites its DOM on its own schedule, with no warning
 * and no versioning. A selector hardcoded into this file breaks silently the
 * day the site ships a redesign, and you find out only when someone notices
 * coverage looks thin -- weeks later, if ever.
 *
 * So selectors are DATA, not code. They load from chrome.storage (managed
 * policy first -- the same mechanism server-config.js already uses -- then a
 * value the background worker cached from the server), with a small built-in
 * fallback so a fresh install still works on day one. Fixing a broken site
 * becomes "push new JSON," not "ship a new extension version and wait."
 *
 * If no profile matches anything, a structural fallback finds the transcript
 * by shape instead of by selector. It cannot tell you who said what, but
 * unattributed recent context beats none, and it never depends on a selector
 * surviving a redesign.
 *
 * Every extraction reports whether it actually found something. Silent
 * failure here is the same mistake morning_report.py explicitly avoids with
 * pending counts: a coverage gap you don't know about is worse than one you
 * do.
 */

const ctxExtractor = (() => {
  const MAX_TURNS = 5;
  const MAX_CHARS_PER_TURN = 4000;  // one turn quoting a huge doc shouldn't blow the budget
  const SLOW_EXTRACT_MS = 30;       // report if a single extraction runs this long
  const MIN_REEXTRACT_MS = 2500;    // prior turns don't change while the user types --
                                     // no need to re-read the transcript at composer-debounce speed

  // Known-stale-within-weeks by design. The managed/remote profile always
  // wins over this if one is present -- see loadProfile().
  const BUILTIN_PROFILES = {
    "chatgpt.com": {
      turn: "[data-message-author-role]",
      roleAttr: "data-message-author-role",
      userValue: "user",
      assistantValue: "assistant",
    },
    "chat.openai.com": {
      turn: "[data-message-author-role]",
      roleAttr: "data-message-author-role",
      userValue: "user",
      assistantValue: "assistant",
    },
    // No verified stable attribute at write time -- deliberately left to the
    // structural fallback rather than guessing a brittle string. Replace
    // once you've confirmed the real markup in devtools.
    "claude.ai": { turn: null },
  };

  let cachedProfile = null;          // { host, profile, at }
  let lastExtract = { at: 0, turns: [] };
  const reportedBrokenFor = new Set(); // one health event per host per page load

  function send(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, payload });
    } catch (_) {
      /* extension context can go away mid-navigation; never throw from here */
    }
  }

  async function loadProfile(host) {
    if (cachedProfile && cachedProfile.host === host) return cachedProfile.profile;

    let remote = null;
    try {
      const managed = await chrome.storage.managed.get("selectorProfiles").catch(() => ({}));
      remote = managed?.selectorProfiles?.[host] || null;
    } catch (_) {}
    if (!remote) {
      try {
        const local = await chrome.storage.local.get("selectorProfiles");
        remote = local?.selectorProfiles?.[host] || null;
      } catch (_) {}
    }

    const profile = remote || BUILTIN_PROFILES[host] || null;
    cachedProfile = { host, profile, at: Date.now() };
    return profile;
  }

  /* ---------- structural fallback ----------
   * Finds the element most likely to be "the transcript" with a cheap shape
   * heuristic -- the container whose direct children most often hold a
   * meaningful amount of text -- then takes its last few children as turns.
   * O(children of a handful of candidate containers), not O(whole DOM).
   */
  function structuralFallback() {
    const candidates = document.querySelectorAll("main, [role='main']");
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      let score = 0;
      for (const child of el.children) {
        const len = (child.textContent || "").trim().length;
        if (len > 20 && len < 20000) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (!best || bestScore < 2) return [];
    return [...best.children].slice(-MAX_TURNS).map((el) => ({
      role: "unknown",
      text: (el.textContent || "").slice(0, MAX_CHARS_PER_TURN),
    }));
  }

  function extractWithProfile(profile) {
    if (!profile?.turn) return null;
    let nodes;
    try {
      nodes = document.querySelectorAll(profile.turn);
    } catch (_) {
      return null; // malformed/stale selector string -- treat as no profile
    }
    if (!nodes.length) return null;

    return [...nodes].slice(-MAX_TURNS).map((el) => {
      const roleVal = profile.roleAttr ? el.getAttribute(profile.roleAttr) : null;
      const role =
        roleVal === profile.userValue
          ? "user"
          : roleVal === profile.assistantValue
          ? "assistant"
          : "unknown";
      return { role, text: (el.textContent || "").slice(0, MAX_CHARS_PER_TURN) };
    });
  }

  function reportBroken(host) {
    if (reportedBrokenFor.has(host)) return;
    reportedBrokenFor.add(host);
    send("event", {
      site: host,
      source: "system",
      severity: "gap",
      note: "context extractor: configured profile matched nothing, using structural fallback",
      ts: new Date().toISOString(),
    });
  }

  /* ---------- public entry point ----------
   * Call this right before a submit-time scan -- not on every keystroke.
   * Debounced/cached to MIN_REEXTRACT_MS regardless of how often callers ask,
   * so an accidental hot call site can't turn this into a per-keystroke cost.
   */
  async function recentContext() {
    const now = Date.now();
    if (now - lastExtract.at < MIN_REEXTRACT_MS) return lastExtract.turns;

    const t0 = performance.now();
    const host = location.hostname;
    const profile = await loadProfile(host);

    let turns = extractWithProfile(profile);
    if (!turns) {
      reportBroken(host);
      turns = structuralFallback();
    }

    const elapsed = performance.now() - t0;
    if (elapsed > SLOW_EXTRACT_MS) {
      send("event", {
        site: host,
        source: "system",
        severity: "gap",
        note: `context extraction took ${Math.round(elapsed)}ms`,
        ts: new Date().toISOString(),
      });
    }

    lastExtract = { at: now, turns };
    return turns;
  }

  return { recentContext };
})();