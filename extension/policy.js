/*
 * Policy resolution.
 *
 * WHAT PROBLEM THIS SOLVES
 * ------------------------
 * v1 had exactly one behavior: if the site is in the manifest, block on match.
 * That is the right default for a twelve-site pilot and the wrong one for an
 * enterprise, because a single fleet contains populations with genuinely
 * different needs:
 *
 *   - Legal and HR handle protected data all day. Block hard.
 *   - IT and GIS paste config snippets into coding assistants as a job
 *     function. Block SSNs, do not block internal hostnames.
 *   - Communications drafts press releases in ChatGPT. Warn, log, move on.
 *   - Everyone on the sanctioned internal assistant should be MONITORED and
 *     never blocked, because that is where you want the traffic to go.
 *
 * A tool with one behavior gets configured for the strictest population,
 * generates false positives for everyone else, and is uninstalled or worked
 * around within a quarter. That is how DLP pilots die -- the README already
 * says so about rule tuning; this is the same failure at the deployment layer.
 *
 * PRECEDENCE, highest wins:
 *   1. siteOverrides[siteId].mode      -- explicit, per-site
 *   2. categoryModes[category]         -- per-category
 *   3. sanctioned site default         -- monitor
 *   4. defaultMode                     -- fleet-wide
 *
 * Rule-level exemptions (exemptRules / exemptRulesBySite) subtract findings
 * AFTER detection, never before. The event log still records what was found
 * and that it was exempted -- an exemption that erases its own evidence is
 * indistinguishable from a bug, and an auditor cannot tell the difference
 * either.
 */

(() => {
  "use strict";

  /* Enforcement modes, least to most restrictive.
   *
   * off        do nothing. Present so a site can be disabled by policy without
   *            removing it from the catalog (removal loses the audit trail of
   *            why it was ever listed).
   * monitor    scan and report, never interrupt. The mode for sanctioned
   *            tools and for the first two weeks of any rollout -- you cannot
   *            tune thresholds you have no data for.
   * warn       block-severity findings become a confirm step. Users can
   *            proceed with a recorded override.
   * enforce    v1 behavior. block = refused, warn = confirm.
   * strict     everything blocks, including warn-severity findings, and
   *            uninspectable attachments are refused rather than flagged.
   */
  const MODES = ["off", "monitor", "warn", "enforce", "strict"];
  const RANK = Object.fromEntries(MODES.map((m, i) => [m, i]));

  /* ===================================================================
   * THE FLOOR: hard identifiers block everywhere, for everyone.
   * ===================================================================
   *
   * A disclosure is equally bad whichever department causes it. A resident
   * whose SSN reaches a public LLM is not harmed less because Communications
   * sent it rather than Legal, and the county's notification obligation does
   * not change either. So the floor is not a per-department setting.
   *
   * An earlier version had only credential/private_key here, and the result
   * was indefensible -- measured, not hypothetical. The SAME resident SSN:
   *
   *     legal          BLOCK      communications  WARN
   *     hr             BLOCK      pilot           ALLOW
   *     health         BLOCK      (everyone on M365)  ALLOW
   *
   * Three separate mechanisms were each independently softening it:
   *   1. defaultMode        communications ran "warn" fleet-wide
   *   2. categoryModes      enterprise_ai:"monitor" on the sanctioned tenant
   *   3. exemptRules        gov_email/case_number turned rules off entirely,
   *                         and an exempted finding no longer counted toward
   *                         the verdict at all
   *
   * Every rule below is a HARD IDENTIFIER -- a formatted value that is never
   * legitimate in a prompt to a public AI service, in any job function. There
   * is no department whose work requires pasting a live SSN or a payment card
   * into ChatGPT. Because the answer is never "yes", the floor costs nothing
   * in false positives, which is exactly why it can be absolute.
   *
   * WHAT THIS DELIBERATELY DOES NOT COVER: warn-severity rules (dob, medical,
   * cjis vocabulary, internal_host, gov_email, case_number). Those are
   * contextual -- "patient" is a leak in Health and a noun everywhere else --
   * and forcing them fleet-wide is what produces the false positives that get
   * a tool uninstalled. Departments still tune THOSE. They no longer tune
   * whether an SSN is allowed to leave.
   *
   * Overriding the floor requires emptying alwaysEnforceRules explicitly in
   * managed policy, which is a visible, auditable act by whoever owns the GPO
   * -- not a side effect of a mode chosen for an unrelated reason. Ordinary
   * exemptRules can no longer reach these. */
  const ALWAYS_ENFORCE = [
    "ssn", "ssn_bare", "ssn_labeled",   // Social Security numbers
    "credit_card",                       // payment cards (Luhn-validated)
    "bank_account",                      // account / routing numbers
    "tx_dl",                             // driver license
    "record_header",                     // bulk record exports
    "bulk_paste",                        // bulk/tabular dumps
    "credential", "private_key",         // secrets
  ];

  const DEFAULT_POLICY = {
    defaultMode: "enforce",
    alwaysEnforceRules: ALWAYS_ENFORCE.slice(),
    // Unknown = a chat-shaped page discovery.js found that is not in the
    // catalog. Default monitor, NOT enforce: a heuristic match blocking a
    // county intranet search box on day one is exactly the incident that gets
    // the extension pulled from the fleet. Report first, promote deliberately.
    unknownSiteMode: "monitor",
    categoryModes: {
      enterprise_ai: "monitor",
      meeting_ai: "monitor",
    },
    siteOverrides: {},
    extraSites: [],
    disabledSites: [],
    exemptRules: [],
    exemptRulesBySite: {},
    // Groups let one GPO cover a department. The workstation's group comes
    // from managed policy (`group`), so IT sets it per-OU and never touches
    // extension code.
    group: null,
    groupPolicies: {},
    // Coverage of non-catalog sites. "catalog" = manifest sites only (v1
    // behavior, narrowest permission ask). "discover" = also run the heuristic
    // detector on other pages, which requires broad host permissions.
    coverage: "catalog",
    /* Cross-message context analysis. OFF by default.
     *
     * It runs on the submit path and reads recent conversation turns, so it
     * costs more than a single-message scan and it is newer than the tuned
     * regexes in rules.js. Both are reasons an admin should switch it on
     * deliberately rather than inherit it.
     *
     *   off      no history is read at all
     *   monitor  findings are reported, never enforced
     *   warn     context findings cap at a confirm step
     *   enforce  a context block refuses the send
     */
    contextMode: "off",
    contextWindow: 5,
    // Never scan these, at all, in any mode. Banking, payroll, health portals:
    // pages where the extension reading composer text is itself the privacy
    // problem. This list wins over everything, including strict.
    neverScan: [
      "*.bankofamerica.com", "*.chase.com", "*.wellsfargo.com",
      "*.adp.com", "*.paychex.com", "*.workday.com",
      "*.myhealth.va.gov", "*.mychart.com",
      "*.irs.gov", "*.ssa.gov",
      "*.tylertech.com", "*.tylerhost.net",
    ],
  };

  function normalizeMode(m) {
    return MODES.includes(m) ? m : null;
  }

  /* Merge order matters: DEFAULT < managed policy < group policy < server push.
   * Group is applied after the fleet policy so a department can tighten or
   * relax within what IT set fleet-wide, and the server push is last so a
   * same-day response to an incident does not require a GPO refresh cycle
   * (which on a county network is measured in hours, not seconds). */
  function mergePolicy(...layers) {
    const out = structuredClone(DEFAULT_POLICY);
    for (const layer of layers) {
      if (!layer) continue;
      for (const [k, v] of Object.entries(layer)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) out[k] = v.slice();
        else if (typeof v === "object" && typeof out[k] === "object" && !Array.isArray(out[k]))
          out[k] = { ...out[k], ...v };
        else out[k] = v;
      }
    }
    if (out.group && out.groupPolicies?.[out.group]) {
      return mergePolicy({ ...out, groupPolicies: {} }, out.groupPolicies[out.group]);
    }
    return out;
  }

  /* Catalog assembled from baseline + policy additions - policy removals.
   * extraSites entries use the same shape as sites.js so IT can paste a site
   * definition straight from a template into a GPO. */
  function effectiveSites(policy) {
    const base = (globalThis.DLP_SITES?.SITES || []).filter(
      (s) => !policy.disabledSites.includes(s.id)
    );
    const extra = (policy.extraSites || [])
      .filter((s) => s && s.id && Array.isArray(s.hosts))
      .map((s) => ({ category: "public_chat", ...s, _source: "policy" }));
    // Policy definitions replace baseline ones with the same id, so IT can fix
    // a rotted selector without waiting for a build.
    const byId = new Map(base.map((s) => [s.id, s]));
    for (const s of extra) byId.set(s.id, s);
    return [...byId.values()];
  }

  function matchNeverScan(policy, host) {
    const hm = globalThis.DLP_SITES?.hostMatches;
    if (!hm) return false;
    return (policy.neverScan || []).some((p) => hm(p, host) || p === host);
  }

  /*
   * Resolve what to do on this page.
   * Returns { mode, site, category, siteId, siteName, exempt:Set, scan:boolean }
   */
  function resolve(policy, host, path) {
    if (matchNeverScan(policy, host)) {
      return {
        mode: "off", scan: false, site: null, siteId: "excluded",
        siteName: host, category: "excluded", exempt: new Set(),
        reason: "neverScan",
      };
    }

    const sites = effectiveSites(policy);
    const sm = globalThis.DLP_SITES?.siteMatches;
    const site = sm ? sites.find((s) => sm(s, host, path)) : null;

    let mode;
    let category;
    let siteId;
    let siteName;

    if (site) {
      category = site.category || "public_chat";
      siteId = site.id;
      siteName = site.name || host;
      mode =
        normalizeMode(policy.siteOverrides?.[site.id]?.mode) ||
        normalizeMode(policy.siteOverrides?.[site.id]) ||
        normalizeMode(policy.categoryModes?.[category]) ||
        (site.sanctioned ? "monitor" : null) ||
        normalizeMode(policy.defaultMode) ||
        "enforce";
    } else {
      category = "unknown";
      siteId = "unknown:" + host;
      siteName = host;
      mode =
        normalizeMode(policy.siteOverrides?.[host]?.mode) ||
        normalizeMode(policy.siteOverrides?.[host]) ||
        normalizeMode(policy.unknownSiteMode) ||
        "monitor";
    }

    const exempt = new Set([
      ...(policy.exemptRules || []),
      ...(policy.exemptRulesBySite?.[siteId] || []),
      ...(policy.exemptRulesBySite?.[host] || []),
    ]);

    return { mode, scan: mode !== "off", site, siteId, siteName, category, exempt };
  }

  /*
   * Translate findings + mode into an action.
   *
   * Returns "allow" | "warn" | "block".
   *
   * Exempted findings are marked, not deleted -- report() still ships them so
   * the server can show "3 findings, 2 exempt by policy". Silent suppression
   * makes tuning impossible: you cannot see that an exemption is too broad if
   * the events it swallows never leave the workstation.
   */
  function decide(mode, findings, exempt, floor = ALWAYS_ENFORCE) {
    const floored = new Set(floor || []);

    /* A floor rule cannot be exempted.
     *
     * This is the third and last softening path. Marking a finding exempt
     * removed it from `live`, so the floor check below -- which searched
     * `live` -- never saw it. Communications exempting gov_email meant
     * "jane@county.gov re: her SSN 123-45-6789" resolved to WARN: dismissible,
     * on a real SSN.
     *
     * An exemption is a statement that a rule is too noisy for this group's
     * work. That argument is coherent for contextual rules and incoherent for
     * a Luhn-valid card number, so the two are now treated differently. To
     * disable a floor rule you must remove it from alwaysEnforceRules, which
     * is a deliberate, auditable edit rather than a side effect. */
    const marked = findings.map((f) =>
      exempt?.has(f.id) && !floored.has(f.id) ? { ...f, exempt: true } : f
    );
    const live = marked.filter((f) => !f.exempt);

    const hasBlock = live.some((f) => f.severity === "block");
    const hasWarn = live.some((f) => f.severity === "warn");

    let action = "allow";
    if (mode === "off" || mode === "monitor") action = "allow";
    else if (mode === "strict") action = hasBlock || hasWarn ? "block" : "allow";
    else if (mode === "enforce") action = hasBlock ? "block" : hasWarn ? "warn" : "allow";
    else if (mode === "warn") action = hasBlock || hasWarn ? "warn" : "allow";

    /* Floor. An exempted rule stays exempt -- that decision was explicit and is
     * recorded on the event. What this stops is a mode set for an unrelated
     * reason quietly softening a secret.
     *
     * "off" is honoured: it means the extension is not operating on this site
     * at all (neverScan, a disabled entry), and half-running there would be
     * worse than not running. Everything above off gets at least a warn. */
    if (floored.size && mode !== "off") {
      const hit = live.find((f) => floored.has(f.id));
      if (hit) {
        /* Block, not warn, even in monitor.
         *
         * monitor exists so a SANCTIONED tool is not blocked, on the reasoning
         * that the tenant is covered by a data-processing agreement. That
         * reasoning holds for county data and does not hold for a secret: a
         * DPA governs how a vendor handles the data you meant to send them,
         * and says nothing about an API key you did not mean to send anyone.
         * A leaked credential is compromised the moment it is pasted,
         * regardless of destination, and rotating it is the only remedy.
         *
         * A 100-box fleet run is what surfaced this -- at 40 boxes the
         * sanctioned-tenant path came up too rarely to notice. */
        const raised = "block";
        if (rank(raised) > rank(action)) {
          return {
            action: raised, findings: marked,
            exemptCount: marked.length - live.length,
            floored: hit.id,
          };
        }
      }
    }

    return { action, findings: marked, exemptCount: marked.length - live.length };
  }

  const ACTION_RANK = { allow: 0, warn: 1, block: 2 };
  const rank = (a) => ACTION_RANK[a] ?? 0;

  function atLeast(mode, floor) {
    return (RANK[mode] ?? 0) >= (RANK[floor] ?? 0);
  }

  const API = {
    MODES, DEFAULT_POLICY, ALWAYS_ENFORCE, mergePolicy, effectiveSites, resolve,
    decide, atLeast, normalizeMode,
  };

  globalThis.DLP_POLICY = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})();
