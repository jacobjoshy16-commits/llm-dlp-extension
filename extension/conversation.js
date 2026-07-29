/*
 * Conversation-context detection.
 *
 * THE HOLE THIS FILLS
 * -------------------
 * Every rule in rules.js reads ONE string: whatever is in the composer right
 * now. That is structurally blind to the most obvious evasion there is --
 * type "her SSN is 123-45", press Enter, then type "6789". Neither message
 * matches anything. The disclosure still happened.
 *
 * agent_client.py already describes this exact analysis in HISTORY_SYSTEM
 * ("details spread across prompts that individually look harmless but together
 * identify a resident"). But that runs at 17:45, on a box, after the fact, and
 * the README is explicit that tier 2 "can block? No -- detection only, after
 * the fact." This brings a bounded version of that judgement forward to the
 * submit gate, where it can still stop the send.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not re-report history. If message 1 contained an SSN, message 5 is
 * not blocked for it -- message 1 was already blocked, reported, and staged on
 * its own. A context layer that re-flags everything in the window would make
 * the tool unusable within an hour: every message after a single flagged one
 * would be refused, and the user would rightly conclude it is broken.
 *
 * So a context finding must be about the COMBINATION. Concretely, a finding
 * fires only when it is invisible to single-message scanning:
 *
 *   split_identifier   a formatted identifier whose match SPANS a message
 *                      boundary. Exists in the stitched text, exists in no
 *                      single message. Near-zero false positive rate, because
 *                      the existing tuned regexes still have to match.
 *   cumulative_identity  N distinct CLASSES of identity attribute spread over
 *                      2+ messages. One resident's name, DOB, and case number
 *                      arriving one per message is a re-identification whether
 *                      or not any single message trips a rule.
 *   evasion_retry      a split identifier for a rule that was already blocked
 *                      earlier in this session. Blocked, then split up and
 *                      resent, is not an accident.
 *   sensitive_thread   anaphora ("the resident I mentioned") pointing back at
 *                      a message that carried a sensitive subject. Warn only.
 *
 * PERFORMANCE IS A CORRECTNESS REQUIREMENT HERE
 * ---------------------------------------------
 * This runs on the submit path, on every AI site, on county hardware that is
 * not new. A context layer that adds 300ms to Enter is worse than no context
 * layer, because people notice latency on the one interaction they perform
 * hundreds of times a day and they will find a way around the tool.
 *
 * So, in order of importance:
 *   1. It does not run at all when the per-message verdict already blocks.
 *      The verdict cannot get worse; scanning further is pure cost. Same
 *      reasoning as the early break in scanChunked().
 *   2. Turn extraction is driven by a dirty flag set by a MutationObserver,
 *      not by polling or by re-querying the DOM on every keystroke. The
 *      observer callback does nothing but set a boolean.
 *   3. Everything is bounded: MAX_TURNS turns, MAX_TURN_CHARS each,
 *      MAX_TOTAL_CHARS overall. A 200KB pasted spreadsheet in the history
 *      contributes its first 4KB and nothing more.
 *   4. A self-disabling watchdog. If extraction blows the time budget
 *      SLOW_STRIKES times, context analysis turns itself off for the tab and
 *      records a gap event. Degrading to v1 behavior is an acceptable
 *      outcome; hanging the composer is not.
 *
 * PRIVACY
 * -------
 * Conversation text never leaves the workstation from here. The findings this
 * produces carry rule ids, redacted samples, and which message indices took
 * part -- never the surrounding text. Staging still ships only the CURRENT
 * prompt, exactly as before. Widening that would turn the review corpus into a
 * transcript of entire conversations, which is precisely the outcome the
 * README's tier-1/tier-2 split exists to avoid.
 */

(() => {
  "use strict";

  const MAX_TURNS = 5;           // messages of history considered
  const MAX_TURN_CHARS = 4000;   // per message
  const MAX_TOTAL_CHARS = 16000; // whole window, hard ceiling
  const EXTRACT_BUDGET_MS = 40;  // per extraction
  const SLOW_STRIKES = 3;        // strikes before self-disabling
  const SESSION_TTL_MS = 60 * 60 * 1000;

  /* Identity attribute CLASSES.
   *
   * Collapsing rule ids into classes matters: ssn, ssn_bare and ssn_labeled
   * all fire on one number, and counting that as three attributes would make
   * a single SSN look like a re-identification. One number is one attribute.
   */
  const IDENTITY_CLASS = {
    ssn: "ssn", ssn_bare: "ssn", ssn_labeled: "ssn",
    credit_card: "financial", bank_account: "financial",
    tx_dl: "license",
    dob: "birthdate",
    case_number: "case", cjis_id: "case",
    medical: "health",
    gov_email: "contact",
    cjis: "criminal_justice",
    internal_host: "infrastructure",
    credential: "credential", private_key: "credential",
  };

  // Attributes that identify a PERSON. Infrastructure and credentials are
  // sensitive but they do not combine into a re-identification, so they are
  // excluded from the cumulative count to keep IT's day survivable.
  const PERSON_CLASSES = new Set([
    "ssn", "financial", "license", "birthdate", "case", "health", "contact",
    "criminal_justice",
  ]);

  const CUMULATIVE_WARN = 3;   // distinct person-classes -> warn
  const CUMULATIVE_BLOCK = 4;  // -> block

  /* Backreference to an earlier subject. Deliberately narrow: bare pronouns
   * ("he", "her") are far too common in ordinary questions to carry any
   * signal, so this requires a determiner plus a person/case noun, or an
   * explicit "mentioned earlier" construction. */
  const ANAPHORA =
    /\b(?:the|that|this|same|said|aforementioned)\s+(?:resident|person|individual|case|matter|client|patient|employee|defendant|arrestee|subject|file|record|incident|complainant|victim|witness)\b|\b(?:mentioned|discussed|described|listed|noted)\s+(?:above|earlier|previously|before)\b/i;

  /* Subjects worth tracking across turns. A prior message about a criminal
   * case or a medical matter, referred back to, is a thread the user is
   * continuing -- which is the shape of the prose leak regex cannot see. */
  const THREAD_RULES = new Set([
    "cjis", "cjis_id", "medical", "case_number", "record_header",
  ]);

  let disabled = false;
  let strikes = 0;
  let dirty = true;
  let observer = null;
  let cachedTurns = null;
  let selectors = null;

  /* Our own record of what this user submitted in this tab.
   *
   * Preferred over DOM scraping wherever both exist, for two reasons: it is
   * definitionally user-authored (no risk of scraping the assistant's reply
   * back in and flagging the model's echo as the employee's disclosure), and
   * it survives virtualized message lists, which unmount older turns and make
   * DOM extraction silently return a truncated history. */
  const submitted = [];        // { text, at, findings }
  const enforced = new Map();  // ruleId -> { action, at }
  let sessionStart = Date.now();

  /* ---------- pure analysis (no DOM; unit-testable) ---------- */

  /* Scan without assessBulk.
   *
   * scan() would run the bulk-shape check over the stitched window, and a
   * conversation about a spreadsheet can easily exceed the 8KB tabular
   * threshold -- producing a "bulk paste" finding for text that was never
   * pasted. The context layer only wants content rules. */
  function scanRules(text, opts = {}) {
    const R = globalThis.DLP_RULES;
    if (!R?.RULES || !text) return [];
    const out = [];
    const counts = {};
    const cap = opts.maxPerRule || 3;
    for (const rule of R.RULES) {
      if (opts.only && !opts.only.has(rule.id)) continue;
      rule.pattern.lastIndex = 0;
      let m;
      while ((m = rule.pattern.exec(text)) !== null) {
        if (m[0].length === 0) { rule.pattern.lastIndex++; continue; }
        if (rule.validate && !rule.validate(m[0], text, m.index)) continue;
        counts[rule.id] = (counts[rule.id] || 0) + 1;
        out.push({
          id: rule.id, label: rule.label, severity: rule.severity,
          index: m.index, length: m[0].length, sample: R.redact(m[0]),
        });
        if (counts[rule.id] >= cap) break;
      }
    }
    return out;
  }

  /* Build the window text and remember where each message ends.
   *
   * Two joins, because evasion takes two shapes and one join cannot see both:
   *   spaced  "...123-45" + " " + "6789"  -- the natural way it reads
   *   tight   "...123-45" +     + "6789"  -- what actually reconstructs the
   *                                          identifier when someone splits a
   *                                          number mid-token
   * Scanning both and keeping cross-boundary hits from either is cheap: the
   * window is capped at 16KB, so this is two bounded regex passes.
   */
  function buildWindow(messages, sep) {
    let text = "";
    const bounds = [];
    for (let i = 0; i < messages.length; i++) {
      if (i > 0) text += sep;
      const start = text.length;
      text += messages[i];
      bounds.push({ i, start, end: text.length });
    }
    return { text, bounds };
  }

  function boundaryIndexes(bounds) {
    // Interior boundaries only -- the end of the final message is not a seam.
    return bounds.slice(0, -1).map((b) => b.end);
  }

  function messagesTouched(bounds, start, end) {
    return bounds.filter((b) => start < b.end && end > b.start).map((b) => b.i);
  }

  /* Findings that exist in the stitched window but in no single message. */
  function splitFindings(messages) {
    if (messages.length < 2) return [];
    const seen = new Map();

    for (const sep of [" ", ""]) {
      const { text, bounds } = buildWindow(messages, sep);
      if (!boundaryIndexes(bounds).length) continue;

      for (const f of scanRules(text)) {
        // Must span a message boundary. A match sitting inside one message was
        // already caught when that message was scanned on its own, and
        // re-reporting it here would double-count the same disclosure.
        //
        // parts.length >= 2 IS that check: a match touching two messages has,
        // by definition, crossed the seam between them. An earlier version
        // also tested the seam offsets explicitly; that was redundant, and a
        // mutation test proved it -- deleting it changed no behavior on any
        // input. Redundant guards are worse than none, because they imply a
        // constraint is enforced somewhere it is not.
        const parts = messagesTouched(bounds, f.index, f.index + f.length);
        if (parts.length < 2) continue;

        const key = f.id + ":" + parts.join(",");
        if (!seen.has(key)) seen.set(key, { ...f, parts });
      }
    }
    return [...seen.values()];
  }

  /* Distinct identity classes spread across more than one message. */
  function cumulativeFindings(perMessage) {
    const classes = new Map(); // class -> Set(message index)
    for (let i = 0; i < perMessage.length; i++) {
      for (const f of perMessage[i]) {
        const cls = IDENTITY_CLASS[f.id];
        if (!cls || !PERSON_CLASSES.has(cls)) continue;
        if (!classes.has(cls)) classes.set(cls, new Set());
        classes.get(cls).add(i);
      }
    }
    // Spread is the point. Three attributes inside one message is just a
    // message with three findings, and the normal path already handled it.
    const spread = new Set();
    for (const idxs of classes.values()) for (const i of idxs) spread.add(i);
    if (classes.size < CUMULATIVE_WARN || spread.size < 2) return [];

    const names = [...classes.keys()].sort();
    return [{
      id: "cumulative_identity",
      label: `identifying details combined across ${spread.size} messages (${names.join(", ")})`,
      severity: classes.size >= CUMULATIVE_BLOCK ? "block" : "warn",
      index: 0, length: 0, sample: "",
      parts: [...spread].sort((a, b) => a - b),
      classes: names,
    }];
  }

  function threadFindings(perMessage, currentText) {
    if (perMessage.length < 2) return [];
    if (!ANAPHORA.test(currentText)) return [];
    const prior = perMessage.slice(0, -1);
    const subjects = new Set();
    prior.forEach((fs) => fs.forEach((f) => {
      if (THREAD_RULES.has(f.id)) subjects.add(f.id);
    }));
    if (!subjects.size) return [];
    return [{
      id: "sensitive_thread",
      label: "continues an earlier sensitive subject in this conversation",
      severity: "warn",
      index: 0, length: 0, sample: "",
      parts: [],
      subjects: [...subjects],
    }];
  }

  /* A split identifier for a rule that was already blocked this session.
   * Blocked, then reassembled across two messages, is not a coincidence. */
  function markEvasion(findings) {
    return findings.map((f) => {
      const prior = enforced.get(f.id);
      if (!prior || prior.action !== "block") return f;
      return {
        ...f,
        id: "evasion_retry",
        label: `${f.label} — split across messages after being blocked earlier`,
        severity: "block",
        origin: f.id,
      };
    });
  }

  /* ---------- DOM extraction ---------- */

  /* Only USER turns. Scraping the assistant's replies back in would flag the
   * model echoing a value the employee already sent -- double-counting a
   * single disclosure, and worse, flagging text the employee did not write. */
  const USER_TURN_SELECTORS = [
    '[data-message-author-role="user"]',
    '[data-testid="user-message"]',
    '[data-testid*="user-turn"]',
    "user-query",
    '[class*="user-message" i]',
    '[class*="message-user" i]',
    '[data-content="user-message"]',
  ];

  const BIG_NODE = 20000;
  function nodeText(el) {
    const cheap = el.textContent || "";
    // innerText forces layout. Past a size where the difference stops
    // mattering for keyword proximity, textContent is the right trade -- the
    // same call this codebase already makes in content.js readText().
    if (cheap.length > BIG_NODE) return cheap;
    return el.innerText || cheap;
  }

  function extractFromDom() {
    const sel = [selectors?.turns, ...USER_TURN_SELECTORS].filter(Boolean).join(", ");
    let nodes;
    try {
      nodes = document.querySelectorAll(sel);
    } catch (_) {
      return [];
    }
    if (!nodes.length) return [];
    const take = [...nodes].slice(-MAX_TURNS);
    const out = [];
    for (const n of take) {
      const t = nodeText(n).trim();
      if (t) out.push(t.slice(0, MAX_TURN_CHARS));
    }
    return out;
  }

  function watchDom() {
    if (observer || typeof MutationObserver === "undefined") return;
    try {
      // The callback is intentionally a single assignment. Doing any real work
      // here would run it on every DOM mutation of a streaming chat response,
      // which on a long answer is thousands of callbacks per second.
      observer = new MutationObserver(() => { dirty = true; });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
  }

  function history() {
    if (!dirty && cachedTurns) return cachedTurns;

    const t0 = performance.now();
    let domTurns = [];
    try {
      domTurns = extractFromDom();
    } catch (_) {
      domTurns = [];
    }
    const cost = performance.now() - t0;

    if (cost > EXTRACT_BUDGET_MS) {
      strikes++;
      if (strikes >= SLOW_STRIKES) {
        disable(`extraction exceeded ${EXTRACT_BUDGET_MS}ms ${strikes}x`);
        return [];
      }
    }

    /* Merge our own submissions with what the DOM shows.
     *
     * The ring buffer is authoritative for this session; the DOM supplies
     * turns from before the content script loaded (a reloaded conversation).
     * Dedupe on a prefix so a DOM node holding the same text we already
     * recorded does not count twice toward cumulative identity. */
    const mine = submitted.map((s) => s.text);
    const merged = [];
    const seen = new Set();
    for (const t of [...domTurns, ...mine]) {
      const k = t.slice(0, 120);
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(t);
    }

    cachedTurns = merged.slice(-MAX_TURNS);
    dirty = false;
    return cachedTurns;
  }

  function disable(reason) {
    disabled = true;
    observer?.disconnect();
    observer = null;
    cachedTurns = null;
    try {
      globalThis.DLP_ON_CONTEXT_DISABLED?.(reason);
    } catch (_) {}
  }

  /* ---------- public API ---------- */

  function init(opts = {}) {
    selectors = opts.selectors || null;
    if (opts.maxTurns) TUNING.turns = Math.max(2, Math.min(opts.maxTurns, 10));
    watchDom();
  }

  const TUNING = { turns: MAX_TURNS };

  /* Record a submission that was allowed through, plus any enforcement that
   * happened. Bounded ring buffer; nothing is persisted. */
  function noteSubmission(text, action, findings) {
    if (Date.now() - sessionStart > SESSION_TTL_MS) reset();
    if (text && text.trim()) {
      submitted.push({ text: text.slice(0, MAX_TURN_CHARS), at: Date.now() });
      while (submitted.length > TUNING.turns) submitted.shift();
      dirty = true;
    }
    if (action === "block" || action === "warn") {
      for (const f of findings || []) {
        enforced.set(f.id, { action, at: Date.now() });
      }
    }
  }

  /*
   * Assess the current composer text against recent history.
   * Returns [] when context adds nothing -- which is the overwhelmingly
   * common case and must stay cheap.
   */
  function assess(currentText) {
    if (disabled || !currentText || !currentText.trim()) return [];
    const R = globalThis.DLP_RULES;
    if (!R?.RULES) return [];

    const t0 = performance.now();
    try {
      const prior = history();
      if (!prior.length) return [];

      let messages = [...prior, currentText.slice(0, MAX_TURN_CHARS)];
      // Drop a duplicate tail: the DOM may already contain the current draft
      // on sites that mirror the composer into the transcript.
      if (messages.length > 1 &&
          messages[messages.length - 2].slice(0, 120) === messages[messages.length - 1].slice(0, 120)) {
        messages.splice(messages.length - 2, 1);
      }
      messages = messages.slice(-(TUNING.turns + 1));

      // Hard ceiling on total work, oldest dropped first.
      let total = messages.reduce((n, m) => n + m.length, 0);
      while (total > MAX_TOTAL_CHARS && messages.length > 2) {
        total -= messages.shift().length;
      }
      if (messages.length < 2) return [];

      const perMessage = messages.map((m) => scanRules(m));

      const findings = [
        ...markEvasion(splitFindings(messages)),
        ...cumulativeFindings(perMessage),
        ...threadFindings(perMessage, messages[messages.length - 1]),
      ];

      return findings.map((f) => ({
        ...f,
        context: true,
        windowSize: messages.length,
      }));
    } catch (_) {
      // Context is an enhancement. A failure here must never take the submit
      // path down with it -- the per-message verdict already stands on its own.
      return [];
    } finally {
      const cost = performance.now() - t0;
      if (cost > EXTRACT_BUDGET_MS * 4) {
        strikes++;
        if (strikes >= SLOW_STRIKES) disable(`assess took ${Math.round(cost)}ms`);
      }
    }
  }

  function reset() {
    submitted.length = 0;
    enforced.clear();
    cachedTurns = null;
    dirty = true;
    sessionStart = Date.now();
  }

  function stats() {
    return {
      disabled, strikes, turns: submitted.length,
      enforcedRules: [...enforced.keys()],
    };
  }

  const API = {
    init, assess, noteSubmission, reset, stats,
    // exported for tests
    _internal: {
      scanRules, splitFindings, cumulativeFindings, threadFindings,
      buildWindow, markEvasion, enforced, IDENTITY_CLASS, ANAPHORA,
    },
  };

  globalThis.DLP_CONTEXT = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})();
