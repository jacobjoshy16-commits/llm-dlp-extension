#!/usr/bin/env node
/*
 * Tests for the enterprise layer.
 *
 * Scope is deliberately narrow: the site matcher and the policy resolver. Both
 * are pure functions, both are load-bearing, and both fail SILENTLY when they
 * are wrong -- a bad match pattern means the content script never runs and no
 * error appears anywhere. That is exactly the class of bug worth testing and
 * the reason these two files were written as pure functions in the first place.
 *
 * Not tested here: DOM interception, which needs a real browser. The README
 * already calls for a synthetic test that loads each site and confirms a
 * known-bad string is still blocked; that belongs in CI with a headless
 * browser, not in this file.
 *
 *   node tools/test.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");

function load(...files) {
  const g = {};
  for (const f of files) {
    const code = readFileSync(join(SRC, f), "utf8");
    // eslint-disable-next-line no-new-func
    new Function("globalThis", "module", code)(g, { exports: {} });
  }
  return g;
}

const g = load("sites.js", "policy.js");
const S = g.DLP_SITES;
const P = g.DLP_POLICY;

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}\n    ${e.message.split("\n")[0]}`);
  }
}

/* ---------- host matching ---------- */

test("exact hostname matches", () => {
  assert.equal(S.hostMatches("chatgpt.com", "chatgpt.com"), true);
});

test("*. matches subdomain and apex", () => {
  assert.equal(S.hostMatches("*.claude.ai", "app.claude.ai"), true);
  assert.equal(S.hostMatches("*.claude.ai", "claude.ai"), true);
});

test("*. does NOT match a suffix-colliding domain", () => {
  // The bug this guards: naive endsWith("claude.ai") matches
  // "evilclaude.ai". A false match here means the extension runs, and
  // reports, on a site nobody authorized.
  assert.equal(S.hostMatches("*.claude.ai", "evilclaude.ai"), false);
  assert.equal(S.hostMatches("*.claude.ai", "notclaude.ai"), false);
});

test("no partial-hostname matches", () => {
  assert.equal(S.hostMatches("chatgpt.com", "chatgpt.com.evil.net"), false);
});

/* ---------- site matching ---------- */

test("path-scoped site does not match the whole origin", () => {
  const grok = S.SITES.find((s) => s.id === "x_grok");
  assert.equal(S.siteMatches(grok, "x.com", "/i/grok"), true);
  assert.equal(S.siteMatches(grok, "x.com", "/home"), false);
});

test("pathless site matches any path on its host", () => {
  const gpt = S.SITES.find((s) => s.id === "openai_chatgpt");
  assert.equal(S.siteMatches(gpt, "chatgpt.com", "/c/abc123"), true);
  assert.equal(S.siteMatches(gpt, "chatgpt.com", "/"), true);
});

test("catalog has no duplicate ids", () => {
  const ids = S.SITES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every catalog category is declared", () => {
  for (const s of S.SITES) assert.ok(S.CATEGORIES[s.category], `${s.id}: ${s.category}`);
});

test("match patterns are well-formed and unique", () => {
  const pats = S.toMatchPatterns(S.SITES);
  assert.equal(new Set(pats).size, pats.length);
  for (const p of pats) assert.match(p, /^https:\/\/[^/]+\/\*$/);
});

/* ---------- policy merge ---------- */

test("merge yields defaults with no layers", () => {
  const p = P.mergePolicy();
  assert.equal(p.defaultMode, "enforce");
  assert.equal(p.coverage, "catalog");
});

test("later layers win, objects merge key-by-key", () => {
  const p = P.mergePolicy(
    { defaultMode: "monitor", categoryModes: { code_ai: "warn" } },
    { categoryModes: { doc_ai: "strict" } }
  );
  assert.equal(p.defaultMode, "monitor");
  assert.equal(p.categoryModes.code_ai, "warn");
  assert.equal(p.categoryModes.doc_ai, "strict");
  // the built-in default survives a partial override
  assert.equal(p.categoryModes.enterprise_ai, "monitor");
});

test("null and undefined layer values do not clobber", () => {
  const p = P.mergePolicy({ defaultMode: "strict" }, { defaultMode: null });
  assert.equal(p.defaultMode, "strict");
});

test("group overlay is applied on top of the base layer", () => {
  const p = P.mergePolicy({
    defaultMode: "enforce",
    group: "legal",
    groupPolicies: { legal: { defaultMode: "strict" } },
  });
  assert.equal(p.defaultMode, "strict");
});

test("a group that does not exist is inert", () => {
  const p = P.mergePolicy({
    defaultMode: "warn", group: "nope", groupPolicies: { legal: { defaultMode: "strict" } },
  });
  assert.equal(p.defaultMode, "warn");
});

/* ---------- resolution ---------- */

test("catalog site resolves to the fleet default", () => {
  const r = P.resolve(P.mergePolicy({ defaultMode: "enforce" }), "chatgpt.com", "/");
  assert.equal(r.mode, "enforce");
  assert.equal(r.siteId, "openai_chatgpt");
});

test("sanctioned site defaults to monitor, not the fleet default", () => {
  const r = P.resolve(
    P.mergePolicy({ defaultMode: "strict", categoryModes: {} }),
    "app.glean.com", "/"
  );
  assert.equal(r.mode, "monitor");
});

test("siteOverrides beats categoryModes", () => {
  const r = P.resolve(
    P.mergePolicy({
      categoryModes: { public_chat: "monitor" },
      siteOverrides: { openai_chatgpt: { mode: "strict" } },
    }),
    "chatgpt.com", "/"
  );
  assert.equal(r.mode, "strict");
});

test("shorthand string siteOverride is accepted", () => {
  const r = P.resolve(
    P.mergePolicy({ siteOverrides: { openai_chatgpt: "off" } }),
    "chatgpt.com", "/"
  );
  assert.equal(r.mode, "off");
  assert.equal(r.scan, false);
});

test("neverScan wins over everything, including strict", () => {
  const r = P.resolve(
    P.mergePolicy({ defaultMode: "strict", neverScan: ["*.workday.com"] }),
    "county.workday.com", "/inbox"
  );
  assert.equal(r.scan, false);
  assert.equal(r.reason, "neverScan");
});

test("unknown host gets unknownSiteMode", () => {
  const r = P.resolve(P.mergePolicy({ unknownSiteMode: "monitor" }), "brand-new-ai.example", "/");
  assert.equal(r.mode, "monitor");
  assert.equal(r.category, "unknown");
});

test("disabledSites removes a site from the catalog", () => {
  const p = P.mergePolicy({ disabledSites: ["openai_chatgpt"] });
  assert.ok(!P.effectiveSites(p).some((s) => s.id === "openai_chatgpt"));
});

test("extraSites are matched like catalog sites", () => {
  const p = P.mergePolicy({
    extraSites: [{ id: "internal_bot", name: "County Bot", hosts: ["ai.county.local"] }],
  });
  const r = P.resolve(p, "ai.county.local", "/");
  assert.equal(r.siteId, "internal_bot");
});

test("an extraSite replaces a catalog entry with the same id", () => {
  const p = P.mergePolicy({
    extraSites: [{ id: "openai_chatgpt", name: "ChatGPT", hosts: ["chatgpt.com"],
                   category: "public_chat", selectors: { send: "#fixed" } }],
  });
  const r = P.resolve(p, "chatgpt.com", "/");
  assert.equal(r.site.selectors.send, "#fixed");
});

/* ---------- decide ---------- */

const BLOCK = [{ id: "ssn", severity: "block" }];
const WARN = [{ id: "dob", severity: "warn" }];
const NONE = [];

test("monitor never interrupts", () => {
  assert.equal(P.decide("monitor", BLOCK, new Set()).action, "allow");
});

test("off never interrupts", () => {
  assert.equal(P.decide("off", BLOCK, new Set()).action, "allow");
});

test("enforce reproduces v1 behavior exactly", () => {
  assert.equal(P.decide("enforce", BLOCK, new Set()).action, "block");
  assert.equal(P.decide("enforce", WARN, new Set()).action, "warn");
  assert.equal(P.decide("enforce", NONE, new Set()).action, "allow");
});

test("warn mode downgrades a block to a confirm step", () => {
  assert.equal(P.decide("warn", BLOCK, new Set()).action, "warn");
});

test("strict promotes a warn to a block", () => {
  assert.equal(P.decide("strict", WARN, new Set()).action, "block");
  assert.equal(P.decide("strict", NONE, new Set()).action, "allow");
});

test("an exempt rule stops enforcing but is still reported", () => {
  const d = P.decide("enforce", BLOCK, new Set(["ssn"]));
  assert.equal(d.action, "allow");
  assert.equal(d.exemptCount, 1);
  // The finding survives in the payload. An exemption that erased its own
  // evidence would be indistinguishable from a detection failure.
  assert.equal(d.findings.length, 1);
  assert.equal(d.findings[0].exempt, true);
});

test("exempting one rule does not clear an unrelated finding", () => {
  const d = P.decide("enforce", [...BLOCK, { id: "credential", severity: "block" }],
                     new Set(["ssn"]));
  assert.equal(d.action, "block");
  assert.equal(d.exemptCount, 1);
});

test("per-site exemptions apply only to that site", () => {
  const p = P.mergePolicy({ exemptRulesBySite: { openai_chatgpt: ["internal_host"] } });
  assert.ok(P.resolve(p, "chatgpt.com", "/").exempt.has("internal_host"));
  assert.ok(!P.resolve(p, "claude.ai", "/").exempt.has("internal_host"));
});

/* ---------- mode ranking (used to clamp server pushes) ---------- */

test("atLeast orders modes correctly", () => {
  assert.equal(P.atLeast("strict", "enforce"), true);
  assert.equal(P.atLeast("monitor", "enforce"), false);
  assert.equal(P.atLeast("enforce", "enforce"), true);
});

/* ---------- departmental samples actually resolve ---------- */

/* ---------- shipped samples, resolved end-to-end ----------
 *
 * These assert on the mode a real page RESOLVES to, stacking baseline +
 * departments exactly as a deployed workstation does. An earlier version of
 * this file asserted on merged fields (p.defaultMode) instead, and missed a
 * genuine bug: the baseline enumerated every category as "enforce", and since
 * categoryModes outranks defaultMode, that silently pinned Legal to enforce
 * while its overlay said strict. Nothing errored. Merged-field assertions
 * cannot see that class of bug -- only resolution can.
 */

const BASELINE = JSON.parse(
  readFileSync(join(SRC, "..", "enterprise", "samples", "policy-baseline.json"), "utf8")
);
const DEPTS = JSON.parse(
  readFileSync(join(SRC, "..", "enterprise", "samples", "policy-departments.json"), "utf8")
);

const forGroup = (group) => P.mergePolicy(BASELINE, { ...DEPTS, group });
const modeAt = (group, host, path = "/") => P.resolve(forGroup(group), host, path).mode;

test("baseline resolves to enforce on a public chat site", () => {
  assert.equal(P.resolve(P.mergePolicy(BASELINE), "chatgpt.com", "/").mode, "enforce");
});

test("baseline never scans county domains", () => {
  assert.equal(
    P.resolve(P.mergePolicy(BASELINE), "some.fortbendcountytx.gov", "/").scan,
    false
  );
});

test("baseline categoryModes lists only deviations from defaultMode", () => {
  // Guards the regression directly: a category restated at the default value
  // outranks and neutralizes every departmental override of it.
  for (const [cat, mode] of Object.entries(BASELINE.categoryModes)) {
    assert.notEqual(
      mode, BASELINE.defaultMode,
      `categoryModes.${cat} restates defaultMode and will override departments`
    );
  }
});

test("strict departments actually resolve to strict on public chat", () => {
  for (const g of ["legal", "hr", "sheriff", "health"]) {
    assert.equal(modeAt(g, "chatgpt.com"), "strict", `${g} on chatgpt.com`);
  }
});

test("departmental overlay beats the baseline category default", () => {
  // Baseline says enterprise_ai=monitor; legal raises it to warn.
  assert.equal(modeAt("legal", "app.glean.com"), "warn");
  assert.equal(modeAt("general", "app.glean.com"), "monitor");
});

test("sheriff hardens media generation above the fleet default", () => {
  assert.equal(modeAt("general", "midjourney.com"), "warn");
  assert.equal(modeAt("sheriff", "midjourney.com"), "strict");
});

test("IT exempts internal_host but never credentials", () => {
  const r = P.resolve(forGroup("it"), "chatgpt.com", "/");
  assert.equal(r.exempt.has("internal_host"), true);
  assert.equal(r.exempt.has("credential"), false);
  assert.equal(r.exempt.has("private_key"), false);
});

test("IT gets a confirm step on coding assistants, not a block", () => {
  assert.equal(modeAt("it", "v0.dev"), "warn");
  assert.equal(modeAt("general", "v0.dev"), "enforce");
});

test("pilot group interrupts nobody", () => {
  const p = forGroup("pilot");
  const r = P.resolve(p, "chatgpt.com", "/");
  assert.equal(r.mode, "monitor");
  assert.equal(P.decide(r.mode, [{ id: "ssn", severity: "block" }], r.exempt).action, "allow");
  assert.equal(p.coverage, "discover");
});

test("neverScan holds for every department, including the strictest", () => {
  for (const g of ["legal", "sheriff", "it", "pilot"]) {
    assert.equal(P.resolve(forGroup(g), "county.workday.com", "/").scan, false, g);
  }
});

test("every group named in the sample resolves without falling back", () => {
  for (const g of Object.keys(DEPTS.groupPolicies)) {
    const m = modeAt(g, "chatgpt.com");
    assert.ok(P.MODES.includes(m), `${g} resolved to ${m}`);
  }
});

/* ---------- report ---------- */

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
