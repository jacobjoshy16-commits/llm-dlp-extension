#!/usr/bin/env node
/*
 * Live decision-path walkthrough, for a demo or a sanity check.
 *
 * Loads the BUILT extension (dist/chrome-catalog) the way Chrome loads it --
 * separate top-level scripts sharing one isolated-world global -- and drives
 * the real scan -> policy -> context path against the shipped sample policies.
 *
 * Nothing here is mocked except the browser itself. If a line prints BLOCK,
 * the real rules.js and policy.js produced that verdict.
 *
 *   node tools/e2e/demo.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(ROOT, "dist", "chrome-catalog");

if (!existsSync(join(DIST, "manifest.json"))) {
  console.error("run `npm run build` first");
  process.exit(1);
}

const ctx = createContext({
  console, structuredClone, setTimeout, clearTimeout,
  performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 },
  navigator: { userAgent: "Chrome/121" },
  document: {
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener: () => {}, documentElement: {}, title: "",
  },
  location: { hostname: "chatgpt.com", pathname: "/" },
  MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  chrome: {
    runtime: { getManifest: () => ({}), sendMessage: () => {}, onMessage: { addListener: () => {} } },
    storage: { local: {}, managed: {}, onChanged: { addListener: () => {} } },
    permissions: {},
  },
});

const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
for (const f of manifest.content_scripts[0].js) {
  if (f === "content.js") continue; // needs a live DOM; the decision path does not
  runInContext(readFileSync(join(DIST, f), "utf8"), ctx, { filename: f });
}

const P = runInContext("globalThis.DLP_POLICY", ctx);
const R = runInContext("globalThis.DLP_RULES", ctx);
const C = runInContext("globalThis.DLP_CONTEXT", ctx);

const baseline = JSON.parse(readFileSync(join(ROOT, "enterprise/samples/policy-baseline.json"), "utf8"));
const depts = JSON.parse(readFileSync(join(ROOT, "enterprise/samples/policy-departments.json"), "utf8"));

const forGroup = (group) =>
  P.mergePolicy(baseline, { ...depts, group, contextMode: "enforce" });

function run(policy, host, text, label) {
  const r = P.resolve(policy, host, "/");
  if (!r.scan) {
    console.log(`  ${label.padEnd(32)} NOT SCANNED   (${r.reason})`);
    return;
  }
  const findings = R.scan(text);
  let d = P.decide(r.mode, findings, r.exempt);
  let via = "pattern";
  if (d.action === "allow") {
    const extra = C.assess(text);
    if (extra.length) {
      d = P.decide(r.mode, [...d.findings, ...extra], r.exempt);
      via = "CONTEXT";
    }
  }
  C.noteSubmission(text, d.action, d.findings);
  const ids = d.findings.filter((f) => !f.exempt).map((f) => f.id).slice(0, 3).join(",");
  console.log(
    `  ${label.padEnd(32)} ${d.action.toUpperCase().padEnd(6)} ` +
    `mode=${String(r.mode).padEnd(8)} via=${via.padEnd(7)} ${ids || "-"}`
  );
}

const head = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

const general = forGroup("general");
C.init({ maxTurns: 5 });

head("1. ordinary work is not interrupted");
run(general, "chatgpt.com", "What is the homestead exemption deadline?", "clean question");
run(general, "chatgpt.com", "Draft a memo about parking policy", "drafting help");

head("2. a formatted identifier is refused");
run(general, "chatgpt.com", "Resident SSN: 123-45-6789 needs review", "SSN in one message");
run(general, "chatpdf.com", "card 4111 1111 1111 1111 on file", "payment card");

head("3. the evasion pattern-matching cannot see");
C.reset();
run(general, "chatgpt.com", "I need help with a resident file", "msg 1 of 3");
run(general, "chatgpt.com", "her ssn is 123-45", "msg 2 (first half)");
run(general, "chatgpt.com", "6789 what do I do next", "msg 3 (second half)");

head("4. same prompt, different department");
for (const g of ["legal", "health", "it", "communications", "pilot"]) {
  C.reset();
  run(forGroup(g), "chatgpt.com", "Patient diagnosis and treatment plan notes", g);
}

head("5. IT can paste infrastructure, but never a secret");
C.reset();
run(forGroup("it"), "v0.dev", "server at 10.1.2.5 is refusing connections", "internal host (exempt)");
run(forGroup("it"), "v0.dev", "api_key = sk-abcdef1234567890", "secret on a warn-mode site");
run(forGroup("it"), "m365.cloud.microsoft", "api_key = sk-abcdef1234567890", "secret on sanctioned tenant");

head("6. sanctioned tools are monitored, not blocked");
C.reset();
run(general, "m365.cloud.microsoft", "Summarize this internal policy draft", "M365 Copilot");
run(general, "chatgpt.com", "Summarize this internal policy draft", "public ChatGPT");

head("7. pages the tool refuses to inspect");
run(general, "county.workday.com", "SSN 123-45-6789", "payroll portal");
run(general, "www.chase.com", "account 123456789", "banking");

console.log("");
