/*
 * Status page.
 *
 * READ-ONLY BY DESIGN. There is no "disable" toggle and no editable field. A
 * DLP control an employee can turn off in its own options page is not a
 * control, and shipping one invites the question "so what stops someone
 * switching it off before pasting the case file?" -- to which the honest
 * answer has to be enterprise policy, not good manners.
 *
 * What it IS for: making the invisible visible. Every failure mode this
 * extension has is silent by nature -- a missing host permission, an evicted
 * worker, a queue that never drains, a site nobody realized was uncovered. A
 * help desk ticket that says "the AI blocker isn't working" is unanswerable
 * without this page.
 */

(() => {
  "use strict";

  const BR = globalThis.DLP_BROWSER;
  const api = BR.api;
  const P = globalThis.DLP_POLICY;

  const rows = (id, pairs) => {
    const t = document.getElementById(id);
    t.innerHTML = pairs
      .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`)
      .join("");
  };

  const esc = (s) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const pill = (mode) => `<span class="pill ${esc(mode)}">${esc(mode)}</span>`;

  async function main() {
    const mf = api.runtime.getManifest();

    let policy = null;
    try {
      policy = (await api.runtime.sendMessage({ type: "getPolicy" }))?.policy;
    } catch (_) {}
    // A null policy here is itself the diagnosis: the worker did not answer.
    const eff = policy || P.DEFAULT_POLICY;

    const managed = await BR.storage.managed.get(null);
    const managedCount = Object.keys(managed || {}).length;

    rows("env", [
      ["Extension version", `<span class="mono">${esc(mf.version)}</span>`],
      ["Browser engine", `<span class="mono">${esc(BR.ENGINE)}</span>`],
      ["Manifest version", `<span class="mono">${esc(BR.manifestVersion)}</span>`],
      ["Background", mf.background?.service_worker ? "service worker" : "event page"],
      [
        "Workstation tag",
        managed?.workstationTag
          ? `<span class="mono">${esc(managed.workstationTag)}</span>`
          : `<span class="bad">not set</span> — attribution will fall back to profile email or "unattributed"`,
      ],
      [
        "Managed policy",
        managedCount
          ? `<span class="ok">applied</span> (${managedCount} keys)`
          : `<span class="bad">none detected</span> — this machine is running compiled-in defaults`,
      ],
      [
        "Worker reachable",
        policy ? '<span class="ok">yes</span>' : '<span class="bad">no reply</span>',
      ],
    ]);

    const catModes = Object.entries(eff.categoryModes || {})
      .map(([c, m]) => `${esc(c)} ${pill(m)}`)
      .join("<br>") || "<span class='mono'>—</span>";

    rows("policy", [
      ["Default mode", pill(eff.defaultMode)],
      ["Unknown sites", pill(eff.unknownSiteMode)],
      ["Coverage", `<span class="mono">${esc(eff.coverage)}</span>`],
      ["Group", eff.group ? `<span class="mono">${esc(eff.group)}</span>` : "<span class='mono'>—</span>"],
      ["Category modes", catModes],
      [
        "Site overrides",
        Object.keys(eff.siteOverrides || {}).length
          ? `<span class="mono">${esc(Object.keys(eff.siteOverrides).join(", "))}</span>`
          : "<span class='mono'>—</span>",
      ],
      [
        "Rule exemptions",
        (eff.exemptRules || []).length
          ? `<span class="mono">${esc(eff.exemptRules.join(", "))}</span>`
          : "<span class='mono'>—</span>",
      ],
    ]);

    document.getElementById("policy-note").textContent =
      eff.coverage === "discover"
        ? "Discover mode is on: pages outside the catalog are scored heuristically and reported."
        : "Catalog mode: only sites in the shipped catalog and in policy extraSites are inspected.";

    const sites = P.effectiveSites(eff);
    const byCat = {};
    for (const s of sites) byCat[s.category] = (byCat[s.category] || 0) + 1;

    let registered = [];
    try {
      registered = (await BR.scripting?.getRegisteredContentScripts?.()) || [];
    } catch (_) {}

    rows("coverage", [
      ["Sites in effect", `${sites.length}`],
      [
        "By category",
        Object.entries(byCat)
          .sort((a, b) => b[1] - a[1])
          .map(([c, n]) => `${esc(c)} — ${n}`)
          .join("<br>"),
      ],
      [
        "Added by policy",
        (eff.extraSites || []).length
          ? `<span class="mono">${esc(eff.extraSites.map((s) => s.id).join(", "))}</span>`
          : "<span class='mono'>—</span>",
      ],
      [
        "Disabled by policy",
        (eff.disabledSites || []).length
          ? `<span class="mono">${esc(eff.disabledSites.join(", "))}</span>`
          : "<span class='mono'>—</span>",
      ],
      [
        "Dynamic registrations",
        registered.length
          ? `<span class="mono">${esc(registered.map((r) => r.id).join(", "))}</span>`
          : "<span class='mono'>—</span> (manifest coverage only)",
      ],
      ["Never scanned", `<span class="mono">${esc((eff.neverScan || []).join(", "))}</span>`],
    ]);

    const all = await BR.storage.local.get(null);
    const ev = Object.keys(all).filter((k) => k.startsWith("ev:")).length;
    const rv = Object.keys(all).filter((k) => k.startsWith("rv:")).length;
    const last = all.lastBatchAt ? new Date(all.lastBatchAt).toLocaleString() : "never";

    rows("queue", [
      ["Metadata events pending", `${ev}`],
      ["Staged prompts pending", `${rv}`],
      ["Last successful batch", `<span class="mono">${esc(last)}</span>`],
    ]);

    const disc = all.discovered || {};
    const today = new Date().toISOString().slice(0, 10);
    const entries = Object.entries(disc).filter(([, v]) => v.day === today);
    const t = document.getElementById("discovered");
    t.innerHTML = entries.length
      ? entries
          .sort((a, b) => (b[1].score || 0) - (a[1].score || 0))
          .map(
            ([host, v]) =>
              `<tr><th><span class="mono">${esc(host)}</span></th>` +
              `<td>score ${esc(v.score)} · ${esc(v.hits)} visit(s)<br>` +
              `<span class="mono">${esc((v.signals || []).join(", "))}</span></td></tr>`
          )
          .join("")
      : `<tr><th><span class="mono">—</span></th><td>none today</td></tr>`;
  }

  main().catch((e) => {
    document.body.insertAdjacentHTML(
      "afterbegin",
      `<p class="bad">status page failed: ${esc(e.message)}</p>`
    );
  });
})();
