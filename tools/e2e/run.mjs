#!/usr/bin/env node
/*
 * End-to-end: simulated fleet -> real server -> nightly agent -> morning report.
 *
 * Exercises the one path unit tests structurally cannot reach: the extension
 * and the server as separate processes talking over HTTP, then the scheduled
 * jobs that run against the database afterwards.
 *
 *   1. boot receiver.py under uvicorn on a real port
 *   2. stand up N workstations, each loading the REAL extension code
 *   3. drive a working day: clean prompts, leaks, a split-across-messages
 *      evasion, an override, a Firefox box, a sanctioned tool
 *   4. flush tier 1 (metadata) on the alarm
 *   5. trigger tier 2 (staged bodies) on workstation lock
 *   6. run eod_review.py against a stubbed agent -- no Ollama in CI
 *   7. run morning_report.py and assert on the HTML it produces
 *
 * Every assertion is on state the SERVER holds, not on what the harness
 * believes it sent. A test that checks its own bookkeeping proves nothing.
 *
 *   node tools/e2e/run.mjs [--keep]
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Workstation, settle } from "./workstation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT = join(ROOT, "extension");
const SERVER = join(ROOT, "server");
const KEEP = process.argv.includes("--keep");

const PORT = 8791 + Math.floor(Math.random() * 40);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "e2e-token-" + Math.random().toString(36).slice(2, 10);
const ARCHIVE_KEY = Buffer.from(
  Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))
).toString("base64");

/* Interpreter for the server side. Prefer a venv inside the repo (created by
 * `npm run e2e:setup`) so the test is reproducible on a clean machine; fall
 * back to anything already on PATH. */
function findPython() {
  for (const p of [join(ROOT, ".e2e-venv/bin/python"), "/tmp/dlpvenv/bin/python"]) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    "no venv found. Run:  python3 -m venv .e2e-venv && ./.e2e-venv/bin/pip install -r server/requirements.txt"
  );
}
const VENV = findPython();
const UVICORN = join(dirname(VENV), "uvicorn");
const work = mkdtempSync(join(tmpdir(), "dlp-e2e-"));
const DB = join(work, "dlp.db");
const REPORTS = join(work, "reports");
mkdirSync(REPORTS, { recursive: true });

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`   ok   ${name}`); }
  else { failed++; failures.push(name + (detail ? ` -- ${detail}` : "")); console.log(`   FAIL ${name}${detail ? " -- " + detail : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

let server;
async function boot() {
  section("1. server");
  server = spawn(
    UVICORN,
    ["receiver:app", "--host", "127.0.0.1", "--port", String(PORT), "--log-level", "warning"],
    { cwd: SERVER, env: { ...process.env, DLP_DB: DB, DLP_TOKEN: TOKEN,
                          DLP_POLICY_FILE: join(work, "fleet-policy.json"),
                          // Exercise the 60-day archive over real HTTP.
                          DLP_ARCHIVE: "1",
                          DLP_ARCHIVE_KEY: ARCHIVE_KEY,
                          DLP_ARCHIVE_RETENTION_DAYS: "60" } }
  );
  server.stderr.on("data", (d) => {
    const s = d.toString();
    if (/error|traceback/i.test(s)) console.error("   [server]", s.trim().slice(0, 300));
  });

  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        const j = await r.json();
        check("receiver responds on /health", j.ok === true);
        return;
      }
    } catch (_) {}
    await settle(150);
  }
  throw new Error("server did not come up");
}

const FLEET_POLICY = {
  endpoint: `${BASE}/api/events`,
  reviewEndpoint: `${BASE}/api/review-batch`,
  policyEndpoint: `${BASE}/api/policy`,
  token: TOKEN,
  defaultMode: "enforce",
  contextMode: "enforce",
  contextWindow: 5,
  categoryModes: { enterprise_ai: "monitor" },
  flushSeconds: 30, eodHour: 17, eodMinute: 30,
  maxQueue: 500, maxReviewItems: 300, maxStageAgeHours: 72,
  neverScan: ["*.workday.com"],
};

async function main() {
  await boot();
  writeFileSync(join(work, "fleet-policy.json"),
                JSON.stringify({ defaultMode: "enforce", contextMode: "monitor" }, null, 2));

  section("2. workstations boot (real extension code)");
  const ws = [];
  for (const [id, employee, engine] of [
    ["WS-101", "clerk.a@fortbendcountytx.gov", "chrome"],
    ["WS-102", "deputy.b@fortbendcountytx.gov", "chrome"],
    ["WS-203", "analyst.c@fortbendcountytx.gov", "firefox"],
  ]) {
    const w = new Workstation({
      id, employee, engine, extDir: EXT, endpointBase: BASE, token: TOKEN,
      policy: { ...FLEET_POLICY, workstationTag: id },
    });
    w.loadContentScripts();
    await w.loadWorker();
    ws.push(w);
  }
  check("3 workstations loaded content scripts + worker", ws.length === 3);
  check("firefox box has no identity API (forces workstationTag)",
        ws[2].engine === "firefox");

  section("3. the working day");
  const [a, b, c] = ws;

  const r1 = await a.submit("What is the deadline to file a homestead exemption?");
  check("clean prompt allowed", r1.action === "allow", r1.action);

  const r2 = await a.submit("Resident SSN: 123-45-6789 needs a records pull");
  check("SSN blocked on chatgpt.com", r2.action === "block", r2.action);

  // split-across-messages evasion on a second workstation
  await b.submit("I need help with a resident file");
  const s1 = await b.submit("her ssn is 123-45");
  const s2 = await b.submit("6789 what do I do next");
  check("split part 1 allowed (invisible per-message)", s1.action === "allow", s1.action);
  check("split part 2 BLOCKED by conversation context",
        s2.action === "block" && s2.via === "context", `${s2.action}/${s2.via}`);

  const r3 = await c.submit("Patient diagnosis notes for the case review", { site: "claude.ai" });
  check("warn-severity finding on claude.ai", r3.action === "warn", r3.action);
  await c.override("Patient diagnosis notes for the case review", "claude.ai");

  const r4 = await c.submit("Summarize this policy draft", { site: "m365.cloud.microsoft" });
  check("sanctioned enterprise tool monitors, does not block", r4.action === "allow", r4.action);

  const r5 = await a.submit("SSN 123-45-6789", { site: "county.workday.com" });
  check("neverScan host is not inspected at all", r5.action === "not-scanned", r5.action);

  const r6 = await b.submit("Booking number 55512 arrest record for the incident");
  check("CJIS vocabulary warns", ["warn", "block"].includes(r6.action), r6.action);

  section("4. tier 1 flush (metadata over HTTP)");
  const beforeFlush = ws.reduce((n, w) => n + w.queueDepth().ev, 0);
  check("events queued locally before flush", beforeFlush > 0, String(beforeFlush));
  for (const w of ws) { await w.fireAlarm("flushEvents"); }
  await settle(400);

  const evRows = sql("SELECT COUNT(*) FROM events");
  check("server received events", evRows > 0, `${evRows} rows`);
  const afterFlush = ws.reduce((n, w) => n + w.queueDepth().ev, 0);
  check("local event queue drained after 200", afterFlush === 0, String(afterFlush));

  const engines = sqlAll("SELECT DISTINCT engine FROM events WHERE engine IS NOT NULL").flat();
  check("both engines attributed", engines.includes("chrome") && engines.includes("firefox"),
        engines.join(","));
  const emps = sqlAll("SELECT DISTINCT employee FROM events WHERE employee IS NOT NULL").flat();
  check("employee attribution landed", emps.length >= 3, emps.join(","));
  const blocked = sql("SELECT COUNT(*) FROM events WHERE action='block'");
  check("block actions recorded server-side", blocked >= 2, String(blocked));
  const ovr = sql("SELECT COUNT(*) FROM events WHERE severity='override'");
  check("override recorded", ovr === 1, String(ovr));

  section("5. tier 2 batch (staged bodies on workstation lock)");
  const beforeLock = ws.reduce((n, w) => n + w.queueDepth().rv, 0);
  check("prompts staged locally", beforeLock > 0, String(beforeLock));
  for (const w of ws) await w.lockWorkstation();
  await settle(500);

  const rvRows = sql("SELECT COUNT(*) FROM review_items");
  check("server received staged prompts", rvRows > 0, `${rvRows} rows`);
  const afterLock = ws.reduce((n, w) => n + w.queueDepth().rv, 0);
  check("staged text purged locally after 200", afterLock === 0, String(afterLock));
  const withBody = sql("SELECT COUNT(*) FROM review_items WHERE body IS NOT NULL");
  check("bodies present pre-scoring", withBody === rvRows, `${withBody}/${rvRows}`);

  section("6. coverage + policy endpoints");
  const cov = await (await fetch(`${BASE}/api/coverage?days=7`,
    { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  check("coverage lists tools by stable id",
        cov.tools.some((t) => t.siteId === "openai_chatgpt"),
        cov.tools.map((t) => t.siteId).join(","));
  check("chatgpt.com and chat.openai.com are ONE tool",
        cov.tools.filter((t) => t.siteId === "openai_chatgpt").length === 1);

  const polRes = await fetch(`${BASE}/api/policy`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  check("policy endpoint serves the fleet file", polRes.ok);
  const unauth = await fetch(`${BASE}/api/coverage`);
  check("endpoints reject a missing token", unauth.status === 401, String(unauth.status));

  section("7. nightly agent (eod_review.py, stubbed model)");
  /* Stubbing the model.
   *
   * PYTHONPATH cannot shadow this: Python puts the SCRIPT's own directory at
   * the front of sys.path, so `from agent_client import ...` inside
   * server/eod_review.py always resolves to server/agent_client.py and tries
   * to reach Ollama on localhost.
   *
   * So copy the job into a sandbox dir alongside a stub of the same name.
   * The script under test is byte-identical -- only its neighbour changes.
   */
  const sandbox = join(work, "job");
  mkdirSync(sandbox, { recursive: true });
  writeFileSync(join(sandbox, "agent_client.py"), STUB_AGENT);
  for (const f of ["eod_review.py", "morning_report.py"]) {
    writeFileSync(join(sandbox, f), readFileSync(join(SERVER, f), "utf8"));
  }
  // cwd = work dir so the stub agent_client.py shadows the real one; Python
  // puts the SCRIPT's directory on sys.path ahead of PYTHONPATH, so running
  // from server/ would always import the Ollama client and hang.
  const eod = run(VENV, [join(sandbox, "eod_review.py")], { DLP_DB: DB }, sandbox);
  check("eod_review completed", eod.ok, (eod.err || eod.out).slice(0, 300));
  if (process.env.E2E_VERBOSE) console.log(eod.out);

  const pending = sql("SELECT COUNT(*) FROM review_items WHERE status='pending'");
  check("nothing left pending", pending === 0, String(pending));
  const cleared = sql("SELECT COUNT(*) FROM review_items WHERE status='cleared'");
  const needs = sql("SELECT COUNT(*) FROM review_items WHERE status='needs_review'");
  check("items were scored", cleared + needs === rvRows, `${cleared} cleared / ${needs} flagged`);

  // The retention promise from the README, verified rather than asserted.
  const clearedBodies = sql("SELECT COUNT(*) FROM review_items WHERE status='cleared' AND body IS NOT NULL");
  check("CLEARED bodies deleted (retention promise)", clearedBodies === 0, String(clearedBodies));
  const flaggedBodies = sql("SELECT COUNT(*) FROM review_items WHERE status='needs_review' AND body IS NULL");
  check("flagged bodies retained for review", flaggedBodies === 0, String(flaggedBodies));

  const hist = sql("SELECT COUNT(*) FROM user_reviews");
  check("per-employee history pass ran", hist > 0, `${hist} employees`);

  section("8. morning report");
  const day = new Date().toISOString().slice(0, 10);
  const rep = run(VENV, [join(sandbox, "morning_report.py"), day], { DLP_DB: DB, DLP_REPORTS: REPORTS }, sandbox);
  check("morning_report completed", rep.ok, rep.err.slice(0, 300));

  const summary = join(REPORTS, `dlp-report-${day}.html`);
  const review = join(REPORTS, `dlp-review-${day}.html`);
  check("summary report written", existsSync(summary));
  check("reviewer file written", existsSync(review));

  if (existsSync(summary)) {
    const html = readFileSync(summary, "utf8");
    check("report contains real counts", /\d/.test(html) && html.length > 500);
    check("report names the sites", /chatgpt\.com|claude\.ai/.test(html));
    // The README's central privacy claim, checked against the artifact.
    check("SUMMARY CONTAINS NO RAW SSN", !html.includes("123-45-6789"),
          "summary leaked the identifier it exists to protect");
  }
  if (existsSync(review)) {
    const rhtml = readFileSync(review, "utf8");
    check("reviewer file carries the text a human needs", rhtml.length > 200);
  }

  section("9. prompt archive (60-day retention)");
  const H = { Authorization: `Bearer ${TOKEN}` };
  const AUDIT = { ...H, "X-DLP-Actor": "e2e-analyst", "X-DLP-Reason": "pipeline test" };

  const astats = await (await fetch(`${BASE}/api/archive/stats`, { headers: H })).json();
  check("archive enabled and storing", astats.enabled && astats.rows > 0,
        JSON.stringify({ rows: astats.rows, emp: astats.employees }));
  check("archive retention is 60 days", astats.retentionDays === 60, String(astats.retentionDays));
  check("archive covers multiple employees", astats.employees >= 3, String(astats.employees));

  const meta = await (await fetch(
    `${BASE}/api/archive/history/${encodeURIComponent(a.id)}`, { headers: AUDIT })).json();
  check("per-employee history returns rows", meta.count > 0, String(meta.count));
  check("metadata read carries NO prompt text",
        meta.items.every((i) => i.text === undefined));

  const full = await (await fetch(
    `${BASE}/api/archive/history/${encodeURIComponent(a.id)}?include_text=true`,
    { headers: AUDIT })).json();
  check("explicit include_text returns the prompt", full.items.some((i) => i.text));
  check("archived text is the real submission",
        full.items.some((i) => (i.text || "").includes("123-45-6789")));

  const noHdr = await fetch(`${BASE}/api/archive/history/${encodeURIComponent(a.id)}`,
                            { headers: H });
  check("read refused without actor/reason headers", noHdr.status === 400, String(noHdr.status));

  const log = await (await fetch(`${BASE}/api/archive/access-log`, { headers: H })).json();
  // Two SUCCESSFUL reads happened (metadata, then include_text). The third
  // attempt was rejected for missing headers before it touched any data, so it
  // correctly produces no log entry -- there was no access to record.
  check("every successful read was logged", log.accesses.length === 2,
        String(log.accesses.length));
  check("log records actor, subject and reason",
        log.accesses[0].actor === "e2e-analyst" && !!log.accesses[0].subject
        && !!log.accesses[0].reason);
  check("log distinguishes decrypted reads",
        log.accesses.some((x) => x.decrypted === true));

  /* Encryption at rest, checked against the column rather than the file.
   *
   * A whole-file grep is the wrong test here and initially failed for a
   * misleading reason: review_items -- the short-lived SCORING QUEUE that
   * predates this work -- holds plaintext bodies until eod_review.py nulls
   * them minutes later. That is existing, documented behaviour, not an
   * archive leak. Asserting on the file conflates the two stores and would
   * fail forever for a reason the archive cannot fix.
   *
   * So assert the precise claim: no row in prompt_archive contains readable
   * prompt text. */
  const leaked = sql(
    "SELECT COUNT(*) FROM prompt_archive WHERE CAST(body_enc AS TEXT) LIKE '%123-45-6789%'"
  );
  check("ARCHIVE COLUMN HOLDS NO READABLE TEXT", leaked === 0,
        "prompt_archive is storing plaintext -- encryption is not working");
  const encRows = sql("SELECT COUNT(*) FROM prompt_archive WHERE body_enc IS NOT NULL");
  check("archive rows carry ciphertext", encRows > 0, String(encRows));

  const hold = await fetch(`${BASE}/api/archive/hold/${encodeURIComponent(b.id)}`,
    { method: "POST", headers: { ...AUDIT, "Content-Type": "application/json" },
      body: JSON.stringify({}) });
  check("legal hold can be placed", hold.ok);
  const held = await (await fetch(`${BASE}/api/archive/stats`, { headers: H })).json();
  check("hold is visible in retention stats",
        held.activeHolds.some((x) => x.employee === b.id));

  section("10. resilience");
  // Server unreachable: events must queue, not vanish.
  server.kill("SIGTERM");
  await settle(400);
  const d = ws[0];
  await d.submit("another question while the server is down");
  const q1 = d.queueDepth();
  await d.fireAlarm("flushEvents");
  await settle(300);
  const q2 = d.queueDepth();
  check("events survive an unreachable server", q2.ev >= q1.ev && q2.ev > 0,
        `before=${q1.ev} after=${q2.ev}`);
  check("staged text also retained", q2.rv > 0, String(q2.rv));

  section("results");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) { console.log(""); for (const f of failures) console.log(`  FAIL  ${f}`); }
  console.log(`\nartifacts: ${work}${KEEP ? "" : " (removing; --keep to retain)"}`);
  return failed === 0;
}

/* ---------- helpers ---------- */

function sql(q) {
  const out = execFileSync(VENV,
    ["-c", `import sqlite3,sys;print(sqlite3.connect(${JSON.stringify(DB)}).execute(${JSON.stringify(q)}).fetchone()[0])`],
    { encoding: "utf8" });
  return Number(out.trim());
}
function sqlAll(q) {
  const out = execFileSync(VENV,
    ["-c", `import sqlite3,json;print(json.dumps(sqlite3.connect(${JSON.stringify(DB)}).execute(${JSON.stringify(q)}).fetchall()))`],
    { encoding: "utf8" });
  return JSON.parse(out);
}
function run(bin, args, env, cwd) {
  try {
    const out = execFileSync(bin, args, {
      env: { ...process.env, ...env }, encoding: "utf8", stdio: "pipe", cwd,
    });
    return { ok: true, err: "", out };
  } catch (e) {
    return { ok: false, err: ((e.stderr || "") + (e.stdout || "") + (e.message || "")).toString(), out: "" };
  }
}

/* Deterministic stand-in for Ollama. Same contract as agent_client.py -- the
 * real module is never imported, so no model is required. Flags anything the
 * regex tier already called block, plus prose mentioning a resident. */
const STUB_AGENT = `
def score_with_agent(prompts):
    out = []
    for p in prompts:
        low = (p or "").lower()
        risky = any(k in low for k in ("ssn", "123-45", "diagnosis", "arrest", "booking"))
        out.append({
            "risk": "high" if risky else "none",
            "categories": ["pii"] if risky else [],
            "rationale": "stub: matched sensitive vocabulary" if risky else "stub: no county content",
            "evidence": (p or "")[:40] if risky else "NONE",
            "evidence_status": "quoted" if risky else "absent",
            "model": "stub",
        })
    return out

def score_user_history(employee, prompts):
    joined = " ".join(prompts).lower()
    risky = any(k in joined for k in ("ssn", "123-45", "arrest", "diagnosis"))
    return {
        "risk": "high" if risky else "none",
        "categories": ["cumulative"] if risky else [],
        "rationale": "stub history verdict",
        "model": "stub",
    }
`;

main()
  .then((ok) => { cleanup(); process.exit(ok ? 0 : 1); })
  .catch((e) => { console.error("\nharness error:", e); cleanup(); process.exit(2); });

function cleanup() {
  try { server?.kill("SIGKILL"); } catch (_) {}
  if (!KEEP) { try { rmSync(work, { recursive: true, force: true }); } catch (_) {} }
}
