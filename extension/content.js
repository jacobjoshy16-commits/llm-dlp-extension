/*
 * Interception layer.
 *
 * DESIGN NOTE -- read before changing anything here.
 *
 * The obvious implementation is: intercept Enter, preventDefault, scan, then
 * replay the keystroke if it's clean. That implementation is broken. The
 * replayed event re-enters the same handler, which blocks it and replays
 * again, forever -- a spin loop that pins a CPU core and makes the tab
 * unusable. An earlier version of this file did exactly that.
 *
 * So instead: scan continuously as the user types (debounced, off the submit
 * path), and keep a verdict for the exact text currently in the composer. When
 * Enter arrives we already know the answer, so the handler is synchronous and
 * -- in the overwhelmingly common clean case -- does nothing at all. No
 * preventDefault, no replay, no loop possible.
 *
 * Replay survives only as a fallback for the rare case where text changed
 * between the last scan and submit. It is guarded three ways: a reentrancy
 * flag, an event tag, and a depth counter.
 */

(() => {
  "use strict";

  const SITE = location.hostname;

  /*
   * Send-button identification.
   *
   * Do NOT match bare button[type="submit"] globally. On chatgpt.com, eight
   * different buttons carry type="submit" -- including "Dismiss", "Close",
   * "Continue", and "Back to ChatGPT" dialog buttons. A global match makes the
   * click gate hijack every dialog interaction whenever the composer has text
   * (dialogs stop closing, login buttons turn into message sends), and makes
   * submitNow click whichever matching button happens to come first in the DOM.
   *
   * So: explicit send hints match anywhere; type="submit" counts only when the
   * button lives in the same <form> as a composer.
   */
  const SEND_HINT = 'button[data-testid*="send"], button[aria-label*="Send" i]';

  function isSendButton(btn) {
    if (!btn || btn.tagName !== "BUTTON") return false;
    if (btn.matches(SEND_HINT)) return true;
    if (btn.getAttribute("type") !== "submit") return false;
    const form = btn.closest("form");
    return !!(form && form.querySelector('textarea, [contenteditable="true"]'));
  }

  function findSendButton(el) {
    const form = el?.closest?.("form");
    if (form) {
      const b = form.querySelector(`${SEND_HINT}, button[type="submit"]`);
      if (b) return b;
    }
    return document.querySelector(SEND_HINT);
  }

  const acknowledged = new Set(); // hashes the user chose to send anyway
  const reported = new Set();     // hash|source pairs already sent upstream

  /* Risk carried by pasted content the composer scan may never see.
   *
   * Some sites (Gemini among them) intercept the paste and move the content
   * into an attachment/preview outside the composer, or rewrite it in their
   * editor model. Scanning the composer at submit time then reads none of it.
   * The clipboard is the only place a paste can reliably be inspected, so
   * inspect it there and carry the verdict forward to the submit gate. */
  let pasteRisk = null; // { findings, severity, at }
  const PASTE_RISK_TTL = 10 * 60 * 1000;

  function activePasteRisk() {
    if (pasteRisk && Date.now() - pasteRisk.at > PASTE_RISK_TTL) pasteRisk = null;
    return pasteRisk;
  }

  function mergeVerdict(v) {
    const pr = activePasteRisk();
    if (!pr || !v) return v;
    const severity =
      v.severity === "block" || pr.severity === "block"
        ? "block"
        : v.severity === "warn" || pr.severity === "warn"
        ? "warn"
        : v.severity;
    return { ...v, severity, findings: v.findings.concat(pr.findings) };
  }

  let overlayOpen = false;
  let replaying = false;
  let replayDepth = 0;
  let composerCache = { el: null, at: 0 };
  let scanning = false;
  let debounceTimer = null;

  // Verdict for the exact string currently in the composer.
  let cached = { text: null, findings: [], severity: null, hash: null };

  /* ---------- composer access ---------- */

  function activeComposer() {
    const el = document.activeElement;
    if (el) {
      if (el.tagName === "TEXTAREA") return el;
      if (el.tagName === "INPUT" && /text|search/.test(el.type)) return el;
      if (el.isContentEditable) return el;
    }
    const now = Date.now();
    if (composerCache.el && now - composerCache.at < 1000 && composerCache.el.isConnected)
      return composerCache.el;
    const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
      .filter((n) => n.offsetParent !== null);
    const best = candidates.sort((a, b) => b.clientHeight - a.clientHeight)[0] || null;
    composerCache = { el: best, at: now };
    return best;
  }

  // innerText forces a full layout reflow. On a composer holding a pasted
  // spreadsheet that alone is a visible stall, so use textContent past a size
  // where the difference stops mattering for keyword-proximity checks.
  const BIG = 40000;
  function readText(el) {
    if (!el) return "";
    if ("value" in el) return el.value || "";
    const cheap = el.textContent || "";
    if (cheap.length > BIG) return cheap;
    return el.innerText || cheap;
  }

  async function sha256(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /* ---------- verdicts ---------- */

  async function computeVerdict(text) {
    const findings = await DLP_RULES.scanChunked(text);
    return {
      text,
      findings,
      severity: DLP_RULES.worstSeverity(findings),
      hash: await sha256(text),
    };
  }

  function permitted(v) {
    if (!v || v.severity === null) return false;
    if (v.severity === "clean") return true;
    return v.severity === "warn" && acknowledged.has(v.hash);
  }

  /* Fire-and-forget. Never awaited on the submit path. */
  function report(v, source) {
    const key = v.hash + "|" + source;
    if (reported.has(key)) return;
    reported.add(key);
    if (reported.size > 500) reported.clear();

    chrome.runtime.sendMessage({
      type: "event",
      payload: {
        site: SITE,
        source,
        severity: v.severity,
        charCount: v.text.length,
        promptHash: v.hash,
        findings: v.findings.map(({ id, label, severity, sample }) => ({
          id, label, severity, sample,
        })),
        ts: new Date().toISOString(),
      },
    });

    // Full-capture policy: every prompt is staged so the nightly agent can
    // analyze the user's complete input history, not just flagged items.
    const MAX_STAGE = 262144;
    chrome.runtime.sendMessage({
      type: "stage",
      payload: {
        site: SITE,
        source,
        severity: v.severity,
        promptHash: v.hash,
        fullLength: v.text.length,
        truncated: v.text.length > MAX_STAGE,
        text: v.text.slice(0, MAX_STAGE),
        findings: v.findings.map(({ id, label, severity }) => ({ id, label, severity })),
        ts: new Date().toISOString(),
      },
    });
  }

  /* ---------- continuous scanning, off the submit path ---------- */

  function scheduleScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runScan, 180);
  }

  async function runScan() {
    if (scanning) return;
    const text = readText(activeComposer());
    if (!text || text === cached.text) return;
    scanning = true;
    try {
      cached = await computeVerdict(text);
    } catch (_) {
      cached = { text: null, findings: [], severity: null, hash: null };
    } finally {
      scanning = false;
    }
  }

  document.addEventListener("input", scheduleScan, true);
  document.addEventListener("focusin", scheduleScan, true);

  function stop(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  /* ---------- submit ---------- */

  /* Guarded three ways. replayDepth is the backstop: even if the flag and the
   * tag both fail on some future site, recursion dies at depth 1. */
  function submitNow(el) {
    if (replayDepth > 0) return;
    replayDepth++;
    replaying = true;
    try {
      const btn = findSendButton(el);
      if (btn && !btn.disabled) {
        btn.click();
        return;
      }
      if (!el) return;
      el.focus();
      const ev = new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      });
      ev.__dlpPass = true;
      el.dispatchEvent(ev);
    } finally {
      replaying = false;
      replayDepth--;
    }
  }

  function gate(e, source, el, text) {
    // Fast path: we already scanned this exact string.
    if (cached.text === text) {
      const v = mergeVerdict(cached);
      if (permitted(v)) {
        pasteRisk = null; // this send accounts for the pasted content
        report(v, source);
        return; // untouched -- the site's own handler runs normally
      }
      stop(e);
      report(v, source);
      showOverlay(v, () => {
        pasteRisk = null;
        submitNow(el);
      });
      return;
    }

    // Slow path: text changed since the last scan. Hold, decide, then submit.
    stop(e);
    (async () => {
      cached = await computeVerdict(text);
      const v = mergeVerdict(cached);
      report(v, source);
      if (permitted(v)) {
        pasteRisk = null;
        submitNow(el);
      } else {
        showOverlay(v, () => {
          pasteRisk = null;
          submitNow(el);
        });
      }
    })();
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (replaying || e.__dlpPass) return;
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      if (overlayOpen) return stop(e);
      const el = activeComposer();
      const text = readText(el);
      // An empty composer is NOT safe to skip if a risky paste is pending --
      // that is exactly the attachment/chip case.
      if (!text.trim() && !activePasteRisk()) return;
      gate(e, "submit", el, text);
    },
    true
  );

  document.addEventListener(
    "click",
    (e) => {
      if (replaying) return;
      if (!isSendButton(e.target.closest?.("button"))) return;
      if (overlayOpen) return stop(e);
      const el = activeComposer();
      const text = readText(el);
      if (!text.trim() && !activePasteRisk()) return;
      gate(e, "submit", el, text);
    },
    true
  );

  /* ---------- paste ---------- */
  /* Highest-yield signal: bulk leaks are pasted, not typed. */

  document.addEventListener(
    "paste",
    (e) => {
      const pasted = e.clipboardData?.getData("text/plain") || "";
      if (!pasted.trim()) return;

      // Shape check first: microseconds, no regex, and it catches the sheet
      // whose cells hold no formatted identifier anywhere.
      const bulk = DLP_RULES.assessBulk(pasted);
      // Then a full content scan of the clipboard itself. Do NOT rely on the
      // debounced composer scan for pasted content -- if the site moves the
      // paste into a chip or attachment, the composer never contains it and
      // the submit-time scan reads nothing. assessBulk already blocks
      // anything >=60KB, so this synchronous scan is bounded.
      const findings = bulk ? [bulk] : DLP_RULES.scan(pasted);
      if (!findings.length) return;

      const severity = DLP_RULES.worstSeverity(findings);
      const v = { text: pasted, findings, severity, hash: null };
      sha256(pasted).then((h) => {
        v.hash = h;
        report(v, "paste");
      });

      if (severity === "block") {
        // Stop it before the site can relocate it somewhere unreadable.
        stop(e);
        showOverlay(v, null);
        return;
      }

      // warn: let the paste land, but remember what came in. Even if the site
      // moves it out of the composer, the submit gate still knows.
      pasteRisk = { findings, severity, at: Date.now() };
    },
    true
  );

  /* ---------- warning UI ---------- */

  function showOverlay({ severity, findings, hash: h }, onProceed) {
    if (overlayOpen) return;
    overlayOpen = true;

    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });

    const blocking = severity === "block";
    const rows = findings
      .map((f) => `<li><span class="lbl">${f.label}</span><span class="smp">${f.sample || ""}</span></li>`)
      .join("");

    root.innerHTML = `
      <style>
        :host { all: initial; }
        .scrim { position:fixed; inset:0; background:rgba(12,14,18,.72);
                 display:flex; align-items:center; justify-content:center; }
        .panel { width:min(520px,92vw); background:#fff; color:#14171c;
                 border-top:4px solid ${blocking ? "#b31b1b" : "#b07000"};
                 font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; }
        .hd { padding:20px 24px 8px; }
        .eyebrow { font:600 11px/1 ui-monospace,Menlo,monospace; letter-spacing:.12em;
                   text-transform:uppercase; color:${blocking ? "#b31b1b" : "#b07000"}; }
        h2 { margin:10px 0 0; font-size:19px; font-weight:600; }
        p { margin:8px 0 0; color:#3d444d; }
        ul { list-style:none; margin:16px 24px 0; padding:0; border-top:1px solid #e3e6ea; }
        li { display:flex; justify-content:space-between; gap:16px;
             padding:9px 0; border-bottom:1px solid #e3e6ea; }
        .lbl { font-weight:500; }
        .smp { font:12px ui-monospace,Menlo,monospace; color:#6b7280; }
        .ft { display:flex; justify-content:flex-end; gap:10px; padding:18px 24px 20px; }
        button { font:inherit; padding:9px 16px; border:1px solid #14171c;
                 background:#14171c; color:#fff; cursor:pointer; }
        button.ghost { background:#fff; color:#14171c; }
        button:focus-visible { outline:2px solid #0b5fff; outline-offset:2px; }
      </style>
      <div class="scrim" role="alertdialog" aria-modal="true">
        <div class="panel">
          <div class="hd">
            <div class="eyebrow">${blocking ? "Blocked" : "Review required"}</div>
            <h2>${blocking
              ? "This text contains protected county data."
              : "This text may contain protected county data."}</h2>
            <p>${blocking
              ? "It was not sent. Remove the items below, or use the county's internal AI tool for this request."
              : "Confirm the items below are safe to share with a public AI service."}</p>
          </div>
          <ul>${rows}</ul>
          <div class="ft">
            ${blocking ? "" : '<button class="ghost" id="send">Send anyway</button>'}
            <button id="edit">Back to editing</button>
          </div>
        </div>
      </div>`;

    document.documentElement.appendChild(host);
    root.getElementById("edit").focus();

    const onEsc = (ev) => {
      if (ev.key === "Escape") close();
    };
    const close = () => {
      host.remove();
      overlayOpen = false;
      document.removeEventListener("keydown", onEsc, true);
    };
    document.addEventListener("keydown", onEsc, true);

    root.getElementById("edit").addEventListener("click", close);
    root.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") close();
    });
    // A modal that cannot be dismissed would brick the composer if anything
    // above ever throws. Escape is the escape hatch; it declines to send.
    root.getElementById("send")?.addEventListener("click", () => {
      if (h) acknowledged.add(h);
      chrome.runtime.sendMessage({
        type: "event",
        payload: { site: SITE, source: "override", severity: "override",
                   promptHash: h, ts: new Date().toISOString() },
      });
      close();
      onProceed?.();
    });
  }
})();
