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

test("monitor never interrupts on contextual findings", () => {
  // BLOCK here is a floored hard identifier, which monitor no longer softens.
  assert.equal(P.decide("monitor", WARN, new Set()).action, "allow");
  assert.equal(P.decide("monitor", BLOCK, new Set()).action, "block");
});

test("off never interrupts", () => {
  assert.equal(P.decide("off", BLOCK, new Set()).action, "allow");
});

test("enforce reproduces v1 behavior exactly", () => {
  assert.equal(P.decide("enforce", BLOCK, new Set()).action, "block");
  assert.equal(P.decide("enforce", WARN, new Set()).action, "warn");
  assert.equal(P.decide("enforce", NONE, new Set()).action, "allow");
});

test("warn mode downgrades a NON-floored block to a confirm step", () => {
  // record_header and friends are floored; use a rule that is not.
  assert.equal(P.decide("warn", [{ id: "dob", severity: "block" }], new Set()).action, "warn");
  // ...but a hard identifier is not downgradable.
  assert.equal(P.decide("warn", BLOCK, new Set()).action, "block");
});

test("strict promotes a warn to a block", () => {
  assert.equal(P.decide("strict", WARN, new Set()).action, "block");
  assert.equal(P.decide("strict", NONE, new Set()).action, "allow");
});

test("an exempt rule stops enforcing but is still reported", () => {
  // Uses a CONTEXTUAL rule: hard identifiers are no longer exemptable.
  const d = P.decide("enforce", [{ id: "internal_host", severity: "warn" }],
                     new Set(["internal_host"]));
  assert.equal(d.action, "allow");
  assert.equal(d.exemptCount, 1);
  // The finding survives in the payload. An exemption that erased its own
  // evidence would be indistinguishable from a detection failure.
  assert.equal(d.findings.length, 1);
  assert.equal(d.findings[0].exempt, true);
});

test("exempting one rule does not clear an unrelated finding", () => {
  const d = P.decide("enforce",
    [{ id: "internal_host", severity: "warn" }, { id: "medical", severity: "warn" }],
    new Set(["internal_host"]));
  assert.equal(d.action, "warn");
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

test("pilot group interrupts nobody -- for CONTEXTUAL findings", () => {
  // Rewritten. This used to assert that pilot allowed an SSN through, which
  // was the behaviour, and was wrong: a pilot that permits real disclosures is
  // an unmonitored gap. monitor now applies to contextual noise only.
  const p = forGroup("pilot");
  const r = P.resolve(p, "chatgpt.com", "/");
  assert.equal(r.mode, "monitor");
  assert.equal(P.decide(r.mode, [{ id: "medical", severity: "warn" }], r.exempt).action,
               "allow");
  assert.equal(P.decide(r.mode, [{ id: "ssn", severity: "block" }], r.exempt).action,
               "block");
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

/* ---------- always-enforce floor ----------
 *
 * Found by the fleet test: the SAME credential leak resolved to allow, warn,
 * or block depending only on which site the employee picked, because category
 * mode silently downgraded a block-severity secret. The IT overlay's own notes
 * say credential and private_key must "stay live"; the code did not honour it.
 */

test("credential blocks even where the category mode says warn", () => {
  const d = P.decide("warn", [{ id: "credential", severity: "block" }], new Set());
  assert.equal(d.action, "block");
  assert.equal(d.floored, "credential");
});

test("credential BLOCKS even on a monitored sanctioned site", () => {
  // monitor exists so sanctioned tools are not blocked, because the tenant is
  // under a data-processing agreement. That covers county data; it does not
  // cover a secret. A pasted API key is compromised regardless of destination.
  const d = P.decide("monitor", [{ id: "credential", severity: "block" }], new Set());
  assert.equal(d.action, "block");
  assert.equal(d.floored, "credential");
});

test("private_key is floored the same way", () => {
  assert.equal(P.decide("warn", [{ id: "private_key", severity: "block" }], new Set()).action,
               "block");
});

test("off still means off -- the floor does not resurrect a disabled site", () => {
  // neverScan and disabled entries must stay fully inert; half-running there
  // is worse than not running.
  assert.equal(P.decide("off", [{ id: "credential", severity: "block" }], new Set()).action,
               "allow");
});

test("an exemption does NOT override the floor", () => {
  // Reversed deliberately. Exemptions remain the right tool for contextual
  // noise, but "this rule is too noisy for my department" is not a coherent
  // claim about a Luhn-valid card number. Removing a rule from
  // alwaysEnforceRules is the only way out, and that is an auditable edit.
  const d = P.decide("warn", [{ id: "credential", severity: "block" }], new Set(["credential"]));
  assert.equal(d.action, "block");
  assert.equal(d.floored, "credential");
});

test("exemptions still work for contextual rules", () => {
  const d = P.decide("enforce", [{ id: "internal_host", severity: "warn" }],
                     new Set(["internal_host"]));
  assert.equal(d.action, "allow");
  assert.equal(d.exemptCount, 1);
});

test("the floor can be emptied explicitly", () => {
  assert.equal(P.decide("warn", [{ id: "credential", severity: "block" }], new Set(), []).action,
               "warn");
});

test("non-floored rules are still softened by mode", () => {
  // The floor covers hard identifiers only. Contextual rules stay tunable --
  // flattening those would re-create the false positives that get a tool
  // uninstalled, which protects nobody.
  assert.equal(P.decide("warn", [{ id: "medical", severity: "warn" }], new Set()).action, "warn");
  assert.equal(P.decide("monitor", [{ id: "medical", severity: "warn" }], new Set()).action,
               "allow");
  assert.equal(P.decide("monitor", [{ id: "cjis", severity: "warn" }], new Set()).action, "allow");
});

test("IT keeps its internal_host exemption after the floor change", () => {
  const it = forGroup("it");
  const r = P.resolve(it, "v0.dev", "/");
  assert.equal(P.decide(r.mode, [{ id: "internal_host", severity: "warn" }], r.exempt).action,
               "allow");
});

test("a credential is enforced identically on every catalog site", () => {
  // The exact inconsistency the fleet run surfaced.
  const it = forGroup("it");
  const seen = new Set();
  for (const host of ["chatgpt.com", "claude.ai", "m365.cloud.microsoft", "v0.dev",
                      "translate.google.com", "chatpdf.com"]) {
    const r = P.resolve(it, host, "/");
    seen.add(P.decide(r.mode, [{ id: "credential", severity: "block" }], r.exempt).action);
  }
  assert.ok(!seen.has("allow"), `a secret was allowed somewhere: ${[...seen]}`);
});

/* ---------- uniform enforcement across departments ----------
 *
 * A disclosure is equally bad whichever department causes it. These tests
 * exist because that was NOT true: the same resident SSN measured as BLOCK in
 * Legal, WARN in Communications, and ALLOW for Pilot and on the sanctioned
 * tenant. Three mechanisms were each softening it independently -- defaultMode,
 * categoryModes, and exemptRules.
 */

const HARD = [
  ["ssn", "Resident SSN: 123-45-6789 needs review"],
  ["credit_card", "card 4111 1111 1111 1111 on file"],
  ["bank_account", "routing number 123456789 for the transfer"],
  ["credential", "api_key = sk-abcdef1234567890"],
  ["private_key", "-----BEGIN RSA PRIVATE KEY-----"],
];

const ALL_GROUPS = Object.keys(DEPTS.groupPolicies);
const ALL_SITES = ["chatgpt.com", "claude.ai", "m365.cloud.microsoft", "v0.dev",
                   "translate.google.com", "chatpdf.com", "www.perplexity.ai"];

test("every hard identifier BLOCKS in every department", () => {
  for (const [rule, text] of HARD) {
    for (const g of ALL_GROUPS) {
      const p = forGroup(g);
      const r = P.resolve(p, "chatgpt.com", "/");
      const d = P.decide(r.mode, ctxg.DLP_RULES.scan(text), r.exempt);
      assert.equal(d.action, "block", `${rule} in ${g} resolved ${d.action}`);
    }
  }
});

test("every hard identifier BLOCKS on every site, including sanctioned", () => {
  for (const [rule, text] of HARD) {
    for (const host of ALL_SITES) {
      const p = forGroup("general");
      const r = P.resolve(p, host, "/");
      const d = P.decide(r.mode, ctxg.DLP_RULES.scan(text), r.exempt);
      assert.equal(d.action, "block", `${rule} on ${host} resolved ${d.action}`);
    }
  }
});

test("the pilot group does not get to leak while it evaluates", () => {
  // monitor exists to measure false positives before enforcing. A pilot that
  // permits real disclosures is an unmonitored gap, not a pilot.
  const p = forGroup("pilot");
  const r = P.resolve(p, "chatgpt.com", "/");
  assert.equal(r.mode, "monitor");
  assert.equal(P.decide(r.mode, ctxg.DLP_RULES.scan("ssn 123-45-6789"), r.exempt).action,
               "block");
});

test("an exemption cannot reach a floor rule", () => {
  // The exact Communications hole: gov_email exempted, warn mode, real SSN.
  const d = P.decide("warn",
    [{ id: "ssn", severity: "block" }, { id: "gov_email", severity: "warn" }],
    new Set(["gov_email", "ssn"]));
  assert.equal(d.action, "block");
  assert.equal(d.floored, "ssn");
});

test("Communications: county email plus a real SSN still blocks", () => {
  const p = forGroup("communications");
  const r = P.resolve(p, "chatgpt.com", "/");
  const text = "Contact jane.doe@fortbendcountytx.gov re: her SSN 123-45-6789";
  assert.equal(P.decide(r.mode, ctxg.DLP_RULES.scan(text), r.exempt).action, "block");
});

test("GIS: parcel case number exempt, but DOB-plus-SSN still blocks", () => {
  const p = forGroup("gis");
  const r = P.resolve(p, "chatgpt.com", "/");
  assert.ok(r.exempt.has("case_number"));
  const text = "Parcel owner ssn 123-45-6789 in case 22-AB-3344";
  assert.equal(P.decide(r.mode, ctxg.DLP_RULES.scan(text), r.exempt).action, "block");
});

test("contextual rules REMAIN tunable per department", () => {
  // The floor must not flatten everything -- that would re-create the false
  // positives that get a tool uninstalled.
  const itRes = P.resolve(forGroup("it"), "chatgpt.com", "/");
  const legalRes = P.resolve(forGroup("legal"), "chatgpt.com", "/");
  const infra = [{ id: "internal_host", severity: "warn" }];
  const itAction = P.decide(itRes.mode, infra, itRes.exempt).action;
  const legalAction = P.decide(legalRes.mode, infra, legalRes.exempt).action;
  assert.equal(itAction, "allow", "IT should still be able to paste a subnet");
  assert.notEqual(legalAction, "allow", "Legal should not");
});

test("IT keeps internal_host relief without losing credential enforcement", () => {
  const p = forGroup("it");
  const r = P.resolve(p, "v0.dev", "/");
  assert.equal(P.decide(r.mode, ctxg.DLP_RULES.scan("server at 10.1.2.5 refused"), r.exempt).action,
               "allow");
  assert.equal(P.decide(r.mode, ctxg.DLP_RULES.scan("api_key = sk-abcdef1234567890"), r.exempt).action,
               "block");
});

test("the floor covers every block-severity rule in the ruleset", () => {
  // Guards drift: a new block-severity rule added to rules.js without being
  // floored would be silently softenable by any department overlay.
  const blockRules = ctxg.DLP_RULES.RULES
    .filter((r) => r.severity === "block").map((r) => r.id);
  const floor = new Set(P.ALWAYS_ENFORCE);
  const missing = blockRules.filter((id) => !floor.has(id));
  assert.equal(missing.length, 0,
    `block-severity rules missing from ALWAYS_ENFORCE: ${missing.join(", ")}`);
});

/* ---------- report ---------- */

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
