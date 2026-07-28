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

  const DEFAULT_POLICY = {
    defaultMode: "enforce",
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
  function decide(mode, findings, exempt) {
    const marked = findings.map((f) =>
      exempt?.has(f.id) ? { ...f, exempt: true } : f
    );
    const live = marked.filter((f) => !f.exempt);

    const hasBlock = live.some((f) => f.severity === "block");
    const hasWarn = live.some((f) => f.severity === "warn");

    let action = "allow";
    if (mode === "off" || mode === "monitor") action = "allow";
    else if (mode === "strict") action = hasBlock || hasWarn ? "block" : "allow";
    else if (mode === "enforce") action = hasBlock ? "block" : hasWarn ? "warn" : "allow";
    else if (mode === "warn") action = hasBlock || hasWarn ? "warn" : "allow";

    return { action, findings: marked, exemptCount: marked.length - live.length };
  }

  function atLeast(mode, floor) {
    return (RANK[mode] ?? 0) >= (RANK[floor] ?? 0);
  }

  const API = {
    MODES, DEFAULT_POLICY, mergePolicy, effectiveSites, resolve, decide,
    atLeast, normalizeMode,
  };

  globalThis.DLP_POLICY = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})();
