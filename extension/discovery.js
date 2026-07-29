/*
 * Unknown-site discovery.
 *
 * THE PROBLEM A CATALOG CANNOT SOLVE
 * ----------------------------------
 * The catalog in sites.js has ~90 entries. There are thousands of AI front
 * ends, a new one trends every week, and any competent employee can reach one
 * the catalog has never heard of in about fifteen seconds. A pure allowlist
 * approach is permanently one step behind, and the gap is widest exactly when
 * it matters -- the week a new tool goes viral.
 *
 * So in "discover" coverage mode the extension runs everywhere it has host
 * permission and asks a different question: does this page BEHAVE like an AI
 * chat surface? If yes, apply unknownSiteMode (monitor by default) and report
 * the hostname so the catalog can be updated deliberately.
 *
 * WHY MONITOR AND NOT BLOCK
 * -------------------------
 * A heuristic will produce false positives. A false positive in monitor mode
 * is a line in a report that an analyst dismisses in two seconds. A false
 * positive in enforce mode is a county intranet search box that stops working
 * fleet-wide, a help desk queue, and an emergency rollback. The asymmetry is
 * enormous and it is why the default is deliberately weak. Promote a
 * discovered host to enforce by adding it to the catalog or to
 * siteOverrides -- deliberately, after someone looked.
 *
 * COST DISCIPLINE
 * ---------------
 * This runs at document_start on EVERY page in discover mode. It must be
 * nearly free on the 99% of pages that are not AI surfaces:
 *   - the cheap signal checks run once, synchronously, on a bounded DOM
 *   - the observer disconnects permanently after a verdict or after the
 *     budget expires
 *   - nothing is scanned, hashed, or sent until the page scores as a chat
 * If you add a signal here, add one that reads attributes, not one that reads
 * text content of the whole document.
 */

(() => {
  "use strict";

  const SIGNAL_WEIGHTS = {
    // Structural: a large free-text input that is not a search box.
    bigComposer: 3,
    contentEditableComposer: 3,
    // Naming: the page names itself.
    aiKeywordInTitle: 2,
    aiKeywordInMeta: 1,
    // Wiring: send affordance next to the composer.
    sendAffordance: 2,
    // Conversation shape: alternating message roles in the DOM.
    messageRoles: 3,
    // Streaming/markdown output containers are near-universal in chat UIs.
    streamingMarkers: 2,
    // Model picker.
    modelSelector: 2,
  };

  const THRESHOLD = 6;

  const AI_WORDS = /\b(ai|gpt|llm|chat ?bot|assistant|copilot|claude|gemini|prompt|generative)\b/i;

  // Search boxes look like composers. These knock the score down so a site
  // search does not read as a chat surface.
  const SEARCH_HINTS = /\b(search|find|filter|lookup|query the)\b/i;

  function scorePage() {
    const signals = [];
    let score = 0;

    const add = (name) => {
      if (signals.includes(name)) return;
      signals.push(name);
      score += SIGNAL_WEIGHTS[name] || 0;
    };

    // --- composer shape ---
    // Bounded query: take at most 40 candidates. A page with hundreds of
    // textareas is a form builder, not a chat.
    const inputs = [
      ...document.querySelectorAll("textarea, [contenteditable='true']"),
    ].slice(0, 40);

    for (const el of inputs) {
      const label = (
        (el.getAttribute("placeholder") || "") + " " +
        (el.getAttribute("aria-label") || "") + " " +
        (el.getAttribute("name") || "") + " " +
        (el.getAttribute("data-testid") || "")
      ).trim();

      if (SEARCH_HINTS.test(label) && !AI_WORDS.test(label)) continue;

      if (el.isContentEditable) add("contentEditableComposer");
      const r = el.getBoundingClientRect?.();
      if (r && r.width >= 280 && r.height >= 28) add("bigComposer");

      // A send affordance in the same container is the strongest cheap signal
      // that this input submits somewhere rather than filtering a list.
      const scope = el.closest("form, [class*='composer' i], [class*='input' i]") || el.parentElement;
      if (
        scope?.querySelector?.(
          "button[aria-label*='send' i], button[data-testid*='send' i], button[title*='send' i], button[type='submit']"
        )
      ) {
        add("sendAffordance");
      }
    }

    // --- naming ---
    if (AI_WORDS.test(document.title || "")) add("aiKeywordInTitle");
    const desc = document.querySelector("meta[name='description']")?.content || "";
    const ogsite = document.querySelector("meta[property='og:site_name']")?.content || "";
    if (AI_WORDS.test(desc) || AI_WORDS.test(ogsite)) add("aiKeywordInMeta");

    // --- conversation shape ---
    // Attribute-based, so it costs a selector match and not a text walk.
    if (
      document.querySelector(
        "[data-message-author-role], [data-role='assistant'], [data-testid*='conversation-turn'], " +
        "[class*='message-assistant' i], [class*='assistant-message' i], [class*='chat-message' i]"
      )
    ) {
      add("messageRoles");
    }

    if (
      document.querySelector(
        "[class*='markdown' i][class*='prose' i], [data-streaming], [class*='typing-indicator' i], " +
        "[class*='streaming' i]"
      )
    ) {
      add("streamingMarkers");
    }

    if (
      document.querySelector(
        "[data-testid*='model' i][role='button'], [aria-label*='model' i][role='combobox'], " +
        "select[name*='model' i]"
      )
    ) {
      add("modelSelector");
    }

    return { score, signals };
  }

  /*
   * Watch briefly, then stop. Chat UIs are SPAs -- the composer usually does
   * not exist at document_start -- so a single pass at load misses almost
   * everything. But an observer that lives forever on every page in the fleet
   * is a performance liability with a very long tail of complaints.
   *
   * Compromise: sample on a decaying schedule for BUDGET_MS, plus a mutation
   * observer that is throttled to one evaluation per SAMPLE_MS and disconnects
   * the moment the page scores or the budget runs out.
   */
  const BUDGET_MS = 20000;
  const SAMPLE_MS = 750;

  function watch(onDetect) {
    let done = false;
    let lastRun = 0;
    let observer = null;
    const started = Date.now();

    const finish = (result) => {
      if (done) return;
      done = true;
      observer?.disconnect();
      clearInterval(ticker);
      if (result) onDetect(result);
    };

    const evaluate = () => {
      if (done) return;
      const now = Date.now();
      if (now - lastRun < SAMPLE_MS) return;
      lastRun = now;

      let result;
      try {
        result = scorePage();
      } catch (_) {
        return; // never let discovery break a page
      }

      if (result.score >= THRESHOLD) finish(result);
      else if (now - started > BUDGET_MS) finish(null);
    };

    const ticker = setInterval(evaluate, SAMPLE_MS);

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", evaluate, { once: true });
    }

    try {
      observer = new MutationObserver(evaluate);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {
      /* documentElement may not exist yet at document_start on some pages */
    }

    evaluate();
    return { stop: () => finish(null) };
  }

  const API = { scorePage, watch, THRESHOLD, SIGNAL_WEIGHTS };
  globalThis.DLP_DISCOVERY = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})();
