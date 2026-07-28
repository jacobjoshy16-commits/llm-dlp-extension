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
import { createContext, runInContext } from "node:vm";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");

/* Load content-script files the way CHROME does.
 *
 * This used to use `new Function("globalThis", ...)`, which passes a fake
 * global as a parameter. That is not how a content script runs, and the
 * difference hid a real bug: rules.js declares `const DLP_RULES` at top level,
 * which lives in script scope and never reaches the global object. Under the
 * old harness the tests assigned `g.DLP_RULES` by hand, so everything passed
 * while conversation.js -- which reads `globalThis.DLP_RULES` -- was silently
 * inert in an actual browser, returning zero findings forever.
 *
 * vm.createContext + runInContext reproduces the real semantics: every file is
 * a separate top-level script sharing one global, top-level const/let stay in
 * script scope, and only explicit `globalThis.X =` assignments are visible
 * across files. If a module cannot see a dependency in the browser, it cannot
 * see it here either.
 */
function load(...files) {
  const ctx = createContext({
    console,
    performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 },
    setTimeout, clearTimeout, structuredClone,
    TextEncoder, TextDecoder,
    navigator: { userAgent: "Chrome/121" },
    document: {
      querySelectorAll: () => [], querySelector: () => null,
      addEventListener: () => {}, documentElement: {}, title: "",
    },
    location: { hostname: "test.local", pathname: "/" },
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    chrome: {
      runtime: { getManifest: () => ({ manifest_version: 3 }), sendMessage: () => {},
                 onMessage: { addListener: () => {} }, lastError: null },
      storage: { local: {}, managed: {}, onChanged: { addListener: () => {} } },
      permissions: {},
    },
  });
  for (const f of files) {
    runInContext(readFileSync(join(SRC, f), "utf8"), ctx, { filename: f });
  }
  return runInContext("globalThis", ctx);
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


/* ---------- conversation context ----------
 *
 * The failure mode to guard against is NOT "misses a split SSN". It is
 * "flags ordinary conversation", because that is what makes people route
 * around the tool. So roughly half of these assert that context finds
 * NOTHING.
 */

/* Loaded exactly as Chrome loads them -- no hand-assigned globals. If
 * conversation.js cannot reach DLP_RULES here, it cannot reach it in a
 * browser either, which is the whole point. */
const ctxg = load("rules.js", "conversation.js");

const C = ctxg.DLP_CONTEXT;
const CI = C._internal;

test("context module loads and sees the ruleset", () => {
  assert.ok(C && CI && ctxg.DLP_RULES);
});

test("SSN split across two messages is caught", () => {
  const f = CI.splitFindings(["her ssn is 123-45", "6789 thanks"]);
  assert.ok(f.length > 0, "expected a split finding");
  assert.ok(f.some((x) => x.id.startsWith("ssn")));
});

test("split finding names both messages it spans", () => {
  const f = CI.splitFindings(["her ssn is 123-45", "6789"]);
  assert.equal(f[0].parts.length, 2);
  assert.equal(f[0].parts[0], 0);
  assert.equal(f[0].parts[1], 1);
});

test("an SSN wholly inside one message is NOT a context finding", () => {
  // Already caught by the normal per-message path; re-reporting it here would
  // double-count and would re-block every later message in the thread.
  const f = CI.splitFindings(["ssn 123-45-6789", "what is the deadline"]);
  assert.equal(f.length, 0);
});

test("ordinary multi-turn conversation produces nothing", () => {
  const convo = [
    "What is the deadline to file a homestead exemption?",
    "Does that change if the owner turned 65 last year?",
    "Where do they submit the form?",
    "Thanks, and is there a fee?",
  ];
  assert.equal(CI.splitFindings(convo).length, 0);
  assert.equal(CI.cumulativeFindings(convo.map((m) => CI.scanRules(m))).length, 0);
});

test("numbers spanning a boundary that are not identifiers stay clean", () => {
  const f = CI.splitFindings(["the budget line was 4820", "17 dollars over"]);
  assert.equal(f.length, 0);
});

test("cumulative: 3 identity classes over 3 messages warns", () => {
  const msgs = [
    "dob 04/12/1979 for the applicant",
    "case 21-CR-004411 is the matter",
    "reach them at clerk@fortbendcountytx.gov",
  ];
  const f = CI.cumulativeFindings(msgs.map((m) => CI.scanRules(m)));
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "warn");
});

test("cumulative: 4+ classes escalates to block", () => {
  const msgs = [
    "dob 04/12/1979",
    "case 21-CR-004411",
    "clerk@fortbendcountytx.gov",
    "ssn 123-45-6789",
  ];
  const f = CI.cumulativeFindings(msgs.map((m) => CI.scanRules(m)));
  assert.equal(f[0].severity, "block");
});

test("cumulative ignores attributes concentrated in ONE message", () => {
  // Spread is the whole signal. One message with everything in it is just a
  // message the normal scanner already blocked.
  const one = ["dob 04/12/1979 case 21-CR-004411 clerk@fortbendcountytx.gov ssn 123-45-6789"];
  assert.equal(CI.cumulativeFindings(one.map((m) => CI.scanRules(m))).length, 0);
});

test("ssn rule variants collapse to ONE identity class", () => {
  // ssn, ssn_bare and ssn_labeled all fire on a single number. Counting that
  // as three attributes would make one SSN look like a re-identification.
  const cls = new Set(["ssn", "ssn_bare", "ssn_labeled"].map((r) => CI.IDENTITY_CLASS[r]));
  assert.equal(cls.size, 1);
});

test("PERSON_CLASSES excludes infrastructure and credentials", () => {
  // IT's normal day is subnets, hostnames, and tokens spread across messages.
  // Those are sensitive, but they do not COMBINE into the re-identification of
  // a person, and counting them that way would block IT's routine work -- the
  // exact false positive that gets a tool routed around.
  //
  // Asserted structurally, on the class map itself, rather than behaviourally.
  // A mutation test showed why: there are only two distinct non-person classes
  // (infrastructure, credential) and CUMULATIVE_WARN is 3, so NO input can
  // currently distinguish "filter present" from "filter absent". A behavioural
  // test here would pass either way and give false confidence.
  //
  // This assertion is the real contract, and it will start doing behavioural
  // work the moment a third non-person class is added.
  const nonPerson = new Set(
    Object.values(CI.IDENTITY_CLASS).filter(
      (c) => !["ssn", "financial", "license", "birthdate", "case", "health",
               "contact", "criminal_justice"].includes(c)
    )
  );
  assert.ok(nonPerson.has("infrastructure"));
  assert.ok(nonPerson.has("credential"));

  // Guard the gap above: if someone adds a third non-person class, the
  // behavioural case becomes reachable and this test must gain teeth.
  assert.ok(
    nonPerson.size <= 2,
    `${nonPerson.size} non-person classes now exist -- cumulative filtering is ` +
    `behaviourally reachable, add a real test for it`
  );
});

test("cumulative counts only DISTINCT person classes, not repeats", () => {
  // Three messages each carrying the same class must not read as three
  // attributes. This is the live half of the filter logic.
  const perMsg = [
    [{ id: "dob", severity: "warn" }],
    [{ id: "dob", severity: "warn" }],
    [{ id: "dob", severity: "warn" }],
  ];
  assert.equal(CI.cumulativeFindings(perMsg).length, 0);
});

test("anaphora alone, with no prior sensitive subject, is clean", () => {
  const msgs = ["what are the office hours", "the resident asked about parking"];
  assert.equal(CI.threadFindings(msgs.map((m) => CI.scanRules(m)), msgs[1]).length, 0);
});

test("anaphora after a sensitive subject warns, never blocks", () => {
  const msgs = ["arrest record for booking number 55512", "what should the resident I mentioned do next"];
  const f = CI.threadFindings(msgs.map((m) => CI.scanRules(m)), msgs[1]);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "warn");
});

test("bare pronouns do not trigger the thread rule", () => {
  assert.equal(CI.ANAPHORA.test("what should she do next"), false);
  assert.equal(CI.ANAPHORA.test("can he appeal it"), false);
});

test("splitting after a block is marked as evasion", () => {
  CI.enforced.set("ssn", { action: "block", at: Date.now() });
  const marked = CI.markEvasion(CI.splitFindings(["her ssn is 123-45", "6789"]));
  assert.ok(marked.some((f) => f.id === "evasion_retry"));
  assert.ok(marked.every((f) => f.id !== "evasion_retry" || f.severity === "block"));
  CI.enforced.clear();
});

test("without a prior block the same split is not evasion", () => {
  CI.enforced.clear();
  const marked = CI.markEvasion(CI.splitFindings(["her ssn is 123-45", "6789"]));
  assert.ok(marked.every((f) => f.id !== "evasion_retry"));
});

test("window stitches with both spaced and tight joins", () => {
  const { text, bounds } = CI.buildWindow(["ab", "cd"], "");
  assert.equal(text, "abcd");
  assert.equal(bounds[1].start, 2);
});

test("assess() returns [] for a single message with no history", () => {
  C.reset();
  assert.equal(C.assess("ssn 123-45-6789").length, 0);
});

test("assess() catches a split across recorded submissions", () => {
  C.reset();
  C.noteSubmission("her ssn is 123-45", "allow", []);
  const f = C.assess("6789");
  assert.ok(f.length > 0);
  assert.ok(f.every((x) => x.context === true));
});

test("assess() stays quiet across an ordinary recorded thread", () => {
  C.reset();
  C.noteSubmission("what is the homestead exemption deadline", "allow", []);
  C.noteSubmission("does it differ for seniors", "allow", []);
  assert.equal(C.assess("where do they file it").length, 0);
});

test("history is bounded to the configured window", () => {
  C.reset();
  C.init({ maxTurns: 3 });
  for (let i = 0; i < 20; i++) C.noteSubmission("message " + i, "allow", []);
  assert.ok(C.stats().turns <= 3, `kept ${C.stats().turns}`);
});

test("a large window stays well under a frame budget", () => {
  C.reset();
  C.init({ maxTurns: 5 });
  // Five 4KB turns -- the documented worst case.
  for (let i = 0; i < 5; i++) {
    C.noteSubmission("resident inquiry regarding permit status. ".repeat(100), "allow", []);
  }
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) C.assess("and what about the fee schedule for next quarter");
  const per = (Date.now() - t0) / 20;
  assert.ok(per < 16, `context assess averaged ${per.toFixed(1)}ms, budget 16ms`);
});

test("reset clears history and enforcement memory", () => {
  C.noteSubmission("ssn 123-45-6789", "block", [{ id: "ssn" }]);
  C.reset();
  assert.equal(C.stats().turns, 0);
  assert.equal(C.stats().enforcedRules.length, 0);
});

/* ---------- report ---------- */

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
