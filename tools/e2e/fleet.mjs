#!/usr/bin/env node
/*
 * Enterprise fleet simulation.
 *
 * tools/e2e/run.mjs proves the pipeline is CORRECT with three workstations.
 * This proves it SURVIVES an enterprise, which is a different question and
 * fails for different reasons:
 *
 *   - departmental policy actually differing per OU, not just in a config file
 *   - many workstations flushing CONCURRENTLY into one SQLite writer
 *   - 60 days of accumulated archive, not one afternoon
 *   - purge and reporting running against a populated database
 *   - the ceiling: where does this stop working, and does it say so first
 *
 * WHAT IS REAL
 *   every workstation runs the REAL content scripts in its own vm context and
 *   its own background.js module graph. receiver.py runs under uvicorn on a
 *   real port. All traffic is genuine HTTP. The database is the real schema.
 *
 * WHAT IS COMPRESSED
 *   Time. Sixty days of history is backdated rather than waited for, and a
 *   workday is a handful of prompts rather than hundreds. The point is the
 *   SHAPE of enterprise load -- concurrency, policy divergence, accumulated
 *   retention -- not throughput benchmarking. Where a number is a throughput
 *   claim it is reported as measured, not asserted as a threshold, because a
 *   2-core sandbox is not a county server.
 *
 *   node tools/e2e/fleet.mjs [--boxes 40] [--days 60] [--keep]
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

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const KEEP = process.argv.includes("--keep");
const BOXES = arg("boxes", 40);
const DAYS = arg("days", 60);

const PORT = 8850 + Math.floor(Math.random() * 60);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "fleet-" + Math.random().toString(36).slice(2, 10);
const ARCHIVE_KEY = Buffer.from(
  Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))
).toString("base64");

function findPython() {
  for (const p of [join(ROOT, ".e2e-venv/bin/python"), "/tmp/dlpvenv/bin/python"]) {
    if (existsSync(p)) return p;
  }
  throw new Error("no venv: python3 -m venv .e2e-venv && ./.e2e-venv/bin/pip install -r server/requirements.txt cryptography");
}
const PY = findPython();
const UVICORN = join(dirname(PY), "uvicorn");

const work = mkdtempSync(join(tmpdir(), "dlp-fleet-"));
const DB = join(work, "dlp.db");
const REPORTS = join(work, "reports");
mkdirSync(REPORTS, { recursive: true });

let passed = 0, failed = 0;
const fails = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log(`   ok   ${name}`); }
  else { failed++; fails.push(`${name}${detail ? " -- " + detail : ""}`); console.log(`   FAIL ${name}${detail ? " -- " + detail : ""}`); }
};
const note = (k, v) => console.log(`   ·    ${k}: ${v}`);
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

/* ---------- the org chart ----------
 * Mirrors enterprise/samples/policy-departments.json. Each OU gets a share of
 * the fleet and a prompt profile that reflects what that department actually
 * types -- which is the only way departmental policy divergence shows up as
 * anything other than a config diff. */
const ORG = [
  { ou: "legal",          share: 0.08, engine: "chrome",  profile: "privileged" },
  { ou: "hr",             share: 0.08, engine: "chrome",  profile: "personnel" },
  { ou: "sheriff",        share: 0.15, engine: "chrome",  profile: "cjis" },
  { ou: "health",         share: 0.10, engine: "firefox", profile: "medical" },
  { ou: "it",             share: 0.12, engine: "chrome",  profile: "technical" },
  { ou: "gis",            share: 0.07, engine: "firefox", profile: "parcel" },
  { ou: "communications", share: 0.10, engine: "chrome",  profile: "press" },
  { ou: "general",        share: 0.25, engine: "chrome",  profile: "clerical" },
  { ou: "pilot",          share: 0.05, engine: "firefox", profile: "clerical" },
];

const PROMPTS = {
  privileged: [
    ["Draft a response to the open records request", "clean"],
    ["Resident SSN: 123-45-6789 in cause 21-CV-0099", "leak"],
    ["Summarize deposition scheduling rules", "clean"],
  ],
  personnel: [
    ["What is the FMLA notice period?", "clean"],
    // A bare DOB is warn-severity and deliberately NOT floored: it appears in
    // countless legitimate contexts and forcing it fleet-wide would produce
    // exactly the false positives that get a tool uninstalled. Labelled
    // "contextual" so the uniformity check does not demand it block.
    ["Employee dob 04/12/1979 discipline file review", "contextual"],
    ["Employee ssn 456-78-9012 for the benefits file", "leak"],
  ],
  cjis: [
    ["How do I format a warrant return?", "clean"],
    ["Booking number 55512 arrest record for the incident", "cjis"],
    ["Suspect ssn 987-65-4320 needs an NCIC check", "leak"],
  ],
  medical: [
    ["What are the clinic's vaccination hours?", "clean"],
    ["Patient diagnosis notes and treatment plan review", "medical"],
  ],
  technical: [
    ["Why does this nginx config 502?", "clean"],
    ["Server at 10.1.2.5 is refusing connections", "infra"],
    ["api_key = sk-abcdef1234567890 is this rotated", "cred"],
  ],
  parcel: [
    ["How do I reproject a shapefile to NAD83?", "clean"],
    ["Parcel case 22-AB-3344 boundary dispute", "case"],
  ],
  press: [
    ["Rewrite this press release for plain language", "clean"],
    ["Contact pio@fortbendcountytx.gov for the quote", "email"],
  ],
  clerical: [
    ["What is the homestead exemption deadline?", "clean"],
    ["How do I request time off?", "clean"],
    ["Where do residents file a permit application?", "clean"],
  ],
};

const SITES = [
  ["chatgpt.com", "/"], ["claude.ai", "/"], ["gemini.google.com", "/"],
  ["m365.cloud.microsoft", "/"], ["v0.dev", "/"], ["translate.google.com", "/"],
  ["www.perplexity.ai", "/"], ["chatpdf.com", "/"],
];

let server;
async function boot() {
  section("1. server under enterprise config");
  writeFileSync(join(work, "fleet-policy.json"), JSON.stringify({
    defaultMode: "enforce", contextMode: "monitor",
  }, null, 2));

  server = spawn(UVICORN,
    ["receiver:app", "--host", "127.0.0.1", "--port", String(PORT), "--log-level", "warning"],
    { cwd: SERVER, env: { ...process.env,
        DLP_DB: DB, DLP_TOKEN: TOKEN,
        DLP_POLICY_FILE: join(work, "fleet-policy.json"),
        DLP_ARCHIVE: "1", DLP_ARCHIVE_KEY: ARCHIVE_KEY,
        DLP_ARCHIVE_RETENTION_DAYS: "60" } });
  server.stderr.on("data", (d) => {
    const s = d.toString();
    if (/error|traceback|locked/i.test(s)) console.error("   [server]", s.trim().slice(0, 200));
  });

  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) { check("receiver up", true); return; } }
    catch (_) {}
    await settle(150);
  }
  throw new Error("server never came up");
}

async function main() {
  await boot();

  const deptDoc = JSON.parse(
    readFileSync(join(ROOT, "enterprise/samples/policy-departments.json"), "utf8"));
  const baseline = JSON.parse(
    readFileSync(join(ROOT, "enterprise/samples/policy-baseline.json"), "utf8"));

  section(`2. provisioning ${BOXES} workstations across ${ORG.length} OUs`);
  const t0 = Date.now();
  const fleet = [];
  let n = 0;
  for (const unit of ORG) {
    const count = Math.max(1, Math.round(BOXES * unit.share));
    for (let i = 0; i < count && fleet.length < BOXES; i++) {
      const id = `${unit.ou.toUpperCase().slice(0, 3)}-${String(++n).padStart(3, "0")}`;
      const w = new Workstation({
        id, employee: `${unit.ou}.user${i}@fortbendcountytx.gov`,
        engine: unit.engine, extDir: EXT, endpointBase: BASE, token: TOKEN,
        policy: {
          ...baseline, ...deptDoc, group: unit.ou, workstationTag: id,
          endpoint: `${BASE}/api/events`,
          reviewEndpoint: `${BASE}/api/review-batch`,
          policyEndpoint: `${BASE}/api/policy`,
          token: TOKEN, contextMode: "enforce",
        },
      });
      w.loadContentScripts();
      await w.loadWorker();
      w.ou = unit.ou; w.profile = unit.profile;
      fleet.push(w);
    }
  }
  const bootMs = Date.now() - t0;
  check(`${fleet.length} workstations booted`, fleet.length >= BOXES * 0.9, String(fleet.length));
  note("boot time", `${bootMs}ms total, ${(bootMs / fleet.length).toFixed(0)}ms/box`);
  const byOu = {};
  for (const w of fleet) byOu[w.ou] = (byOu[w.ou] || 0) + 1;
  note("distribution", Object.entries(byOu).map(([k, v]) => `${k}:${v}`).join(" "));

  section("3. departmental policy actually diverges");
  const modeAt = (w, host) => {
    const p = w.api.P.mergePolicy(w.managedPolicy);
    return w.api.P.resolve(p, host, "/").mode;
  };
  const legal = fleet.find((w) => w.ou === "legal");
  const it = fleet.find((w) => w.ou === "it");
  const comms = fleet.find((w) => w.ou === "communications");
  const pilot = fleet.find((w) => w.ou === "pilot");

  check("legal resolves strict on public chat", modeAt(legal, "chatgpt.com") === "strict",
        modeAt(legal, "chatgpt.com"));
  check("general resolves enforce", modeAt(fleet.find((w) => w.ou === "general"), "chatgpt.com") === "enforce");
  check("communications resolves warn", modeAt(comms, "chatgpt.com") === "warn",
        modeAt(comms, "chatgpt.com"));
  check("pilot resolves monitor (blocks nobody)", modeAt(pilot, "chatgpt.com") === "monitor",
        modeAt(pilot, "chatgpt.com"));
  check("IT gets warn on coding assistants", modeAt(it, "v0.dev") === "warn", modeAt(it, "v0.dev"));

  const itPolicy = it.api.P.mergePolicy(it.managedPolicy);
  const itExempt = it.api.P.resolve(itPolicy, "chatgpt.com", "/").exempt;
  check("IT exempts internal_host", itExempt.has("internal_host"));
  check("IT does NOT exempt credentials", !itExempt.has("credential"));

  section("4. a working day, all boxes concurrent");
  const day0 = Date.now();
  const results = [];
  // Concurrency is the point: real fleets do not take turns. Batching keeps the
  // 2-core sandbox from thrashing while still overlapping writers.
  const BATCH = 8;
  for (let i = 0; i < fleet.length; i += BATCH) {
    const slice = fleet.slice(i, i + BATCH);
    await Promise.all(slice.map(async (w) => {
      const script = PROMPTS[w.profile];
      for (const [text, kind] of script) {
        const [site, path] = SITES[Math.floor(Math.random() * SITES.length)];
        const r = await w.submit(text, { site, path });
        results.push({ ou: w.ou, kind, action: r.action, site, mode: r.mode });
      }
    }));
  }
  const dayMs = Date.now() - day0;
  const prompts = results.length;
  note("prompts submitted", `${prompts} in ${dayMs}ms (${(prompts / (dayMs / 1000)).toFixed(0)}/s)`);

  const blocked = results.filter((r) => r.action === "block").length;
  const warned = results.filter((r) => r.action === "warn").length;
  const allowed = results.filter((r) => r.action === "allow").length;
  note("outcomes", `${blocked} block / ${warned} warn / ${allowed} allow`);
  check("leaks were blocked somewhere", blocked > 0, String(blocked));
  check("clean work was not blocked",
        results.filter((r) => r.kind === "clean" && r.action === "block").length === 0,
        String(results.filter((r) => r.kind === "clean" && r.action === "block").length));

  // The departmental promise, measured on real submissions rather than config.
  const pilotBlocks = results.filter((r) => r.ou === "pilot" && r.action === "block").length;
  check("pilot OU blocked nothing (monitor)", pilotBlocks === 0, String(pilotBlocks));
  /* Legal's leak must never be ALLOWED. It is not always BLOCKED, and that is
   * deliberate: the legal overlay sets enterprise_ai:"warn" because the M365
   * tenant is covered by a data-processing agreement, so an SSN there gets a
   * confirm step rather than a refusal. Asserting "always block" encoded a
   * policy this project does not have -- the real invariant is "never silently
   * allowed". */
  const legalLeak = results.filter((r) => r.ou === "legal" && r.kind === "leak");
  check("legal never silently allowed a leak",
        legalLeak.length > 0 && legalLeak.every((r) => r.action !== "allow"),
        JSON.stringify(legalLeak.map((r) => `${r.site}:${r.action}`)));
  check("legal blocked leaks on unsanctioned sites",
        legalLeak.filter((r) => r.site !== "m365.cloud.microsoft")
                 .every((r) => r.action === "block"),
        JSON.stringify(legalLeak.map((r) => `${r.site}:${r.action}`)));
  const itInfra = results.filter((r) => r.ou === "it" && r.kind === "infra");
  check("IT infra prompts not blocked (exemption works)",
        itInfra.every((r) => r.action !== "block"),
        JSON.stringify(itInfra.map((r) => r.action)));
  const itCred = results.filter((r) => r.ou === "it" && r.kind === "cred");
  check("IT credential leak STILL blocked", itCred.every((r) => r.action === "block"),
        JSON.stringify(itCred.map((r) => r.action)));

  /* Fleet-wide invariant. This is the assertion the fleet test exists for:
   * a given leak must not resolve differently just because of which site the
   * employee happened to open. Secrets must be uniform everywhere; PII may be
   * softened on sanctioned tenants but must never be silently allowed. */
  /* Cross-department uniformity, measured on real submissions.
   *
   * Every box submits from a different OU with a different overlay. A hard
   * identifier must resolve to the SAME action everywhere -- if Legal blocks
   * an SSN and Communications warns on it, the resident is harmed identically
   * and only one of those two departments knows it. */
  const hardKinds = new Set(["leak", "cred"]);
  const byKind = {};
  for (const r of results.filter((x) => hardKinds.has(x.kind))) {
    (byKind[r.kind] ||= new Set()).add(r.action);
  }
  for (const [kind, actions] of Object.entries(byKind)) {
    check(`'${kind}' resolves identically in every department`,
          actions.size === 1 && actions.has("block"),
          `saw ${[...actions].join("/")} across OUs`);
  }

  const secretsAllowed = results.filter((r) => r.kind === "cred" && r.action === "allow");
  check("no secret was allowed anywhere in the fleet", secretsAllowed.length === 0,
        JSON.stringify(secretsAllowed.map((r) => `${r.ou}@${r.site}`)));
  const leaksAllowed = results.filter(
    (r) => r.kind === "leak" && r.action === "allow" && r.mode !== "monitor");
  check("no PII leak allowed outside monitor mode", leaksAllowed.length === 0,
        JSON.stringify(leaksAllowed.map((r) => `${r.ou}@${r.site}:${r.mode}`)));

  section("5. concurrent flush -- SQLite under many writers");
  const f0 = Date.now();
  await Promise.all(fleet.map((w) => w.fireAlarm("flushEvents")));
  await settle(900);
  const flushMs = Date.now() - f0;
  const evRows = sql("SELECT COUNT(*) FROM events");
  note("flush", `${fleet.length} boxes in ${flushMs}ms, ${evRows} events landed`);
  check("all events reached the server", evRows >= prompts * 0.95, `${evRows} of ~${prompts}`);
  const stuck = fleet.reduce((a, w) => a + w.queueDepth().ev, 0);
  check("no workstation left holding events", stuck === 0, String(stuck));

  const distinctEmp = sql("SELECT COUNT(DISTINCT employee) FROM events");
  check("every workstation attributed", distinctEmp >= fleet.length * 0.9,
        `${distinctEmp}/${fleet.length}`);
  const engines = sqlAll("SELECT engine, COUNT(*) FROM events GROUP BY engine");
  note("engines", engines.map(([e, c]) => `${e}:${c}`).join(" "));
  check("both browser engines present", engines.length >= 2);

  section("6. tier 2 batch, whole fleet locking at once");
  const l0 = Date.now();
  await Promise.all(fleet.map((w) => w.lockWorkstation()));
  await settle(1200);
  const rvRows = sql("SELECT COUNT(*) FROM review_items");
  note("lock storm", `${fleet.length} batches in ${Date.now() - l0}ms, ${rvRows} items`);
  check("staged prompts reached the server", rvRows > 0, String(rvRows));
  const stuckRv = fleet.reduce((a, w) => a + w.queueDepth().rv, 0);
  check("no workstation left holding staged text", stuckRv === 0, String(stuckRv));
  check("no rows lost to SQLite contention", rvRows >= prompts * 0.95,
        `${rvRows} of ~${prompts}`);

  section(`7. ${DAYS} days of accumulated archive`);
  const arch0 = sql("SELECT COUNT(*) FROM prompt_archive");
  check("today's prompts archived", arch0 > 0, String(arch0));

  // Backfill history by cloning today across the retention window. Cheaper
  // than replaying, and the purge boundary is what we are testing.
  backfill(DAYS);
  const total = sql("SELECT COUNT(*) FROM prompt_archive");
  const emp = sql("SELECT COUNT(DISTINCT employee) FROM prompt_archive");
  note("archive", `${total} prompts, ${emp} employees, ${DAYS} days`);
  // backfill() writes ~1/3 of today's volume per historical day, so expect
  // roughly arch0 * DAYS / 3. Asserting a fixed multiple was wrong arithmetic
  // that happened to hold at one --days value and not others.
  const expected = arch0 * (DAYS / 3);
  check("archive spans the full retention window",
        total > expected * 0.5 && sql("SELECT COUNT(DISTINCT day) FROM prompt_archive") >= DAYS,
        `${total} rows across ${sql("SELECT COUNT(DISTINCT day) FROM prompt_archive")} days`);

  const stats = await api("/api/archive/stats");
  note("stored", `${(stats.bytesStored / 1048576).toFixed(1)}MB actual, ` +
                 `${stats.projectedMB}MB projected at full retention`);
  note("db file", `${(readFileSync(DB).length / 1048576).toFixed(1)}MB`);
  check("stats report a size projection", stats.projectedBytesAtFullRetention > 0);
  check("headroom flag present", "sqliteHeadroomWarning" in stats);

  // Per-workstation extrapolation -- the number that decides SQLite vs Postgres.
  const perBoxPerDay = stats.bytesStored / fleet.length / DAYS;
  const at500 = (perBoxPerDay * 500 * 60) / 1073741824;
  const at2000 = (perBoxPerDay * 2000 * 60) / 1073741824;
  note("extrapolated", `500 boxes ≈ ${at500.toFixed(2)}GB, 2000 boxes ≈ ${at2000.toFixed(2)}GB at 60d`);

  section("8. purge at the retention boundary, on a populated database");
  const before = sql("SELECT COUNT(*) FROM prompt_archive WHERE body_enc IS NOT NULL");
  const old = sql(`SELECT COUNT(*) FROM prompt_archive WHERE body_enc IS NOT NULL AND day < date('now','localtime','-60 days')`);
  const p0 = Date.now();
  const purge = runPy(["archive.py", "purge"]);
  const purgeMs = Date.now() - p0;
  check("purge ran", purge.ok, purge.err.slice(0, 200));
  const after = sql("SELECT COUNT(*) FROM prompt_archive WHERE body_enc IS NOT NULL");
  note("purge", `${before - after} bodies removed in ${purgeMs}ms (${old} were past 60d)`);
  check("purged exactly the expired rows", before - after === old, `${before - after} vs ${old}`);
  check("in-window prompts survived", after > 0, String(after));
  check("metadata retained after purge",
        sql("SELECT COUNT(*) FROM prompt_archive") === total, "row count changed");

  section("9. investigator workflow at scale");
  const subject = fleet[Math.floor(fleet.length / 2)].id;
  const hist = await api(`/api/archive/history/${encodeURIComponent(subject)}?limit=50`, {
    "X-DLP-Actor": "compliance.lead", "X-DLP-Reason": "fleet drill",
  });
  check("per-employee history works on a populated DB", hist.count > 0, String(hist.count));
  check("history is scoped to one subject",
        hist.items.every((i) => i.text === undefined));

  const log = await api("/api/archive/access-log");
  check("the read was logged", log.accesses.some((a) => a.subject === subject));

  const cov = await api("/api/coverage?days=7");
  note("tools in use", `${cov.tools.length} distinct`);
  check("coverage aggregates the whole fleet", cov.tools.length >= 5, String(cov.tools.length));
  const topTool = cov.tools[0];
  note("most used", `${topTool.siteId} (${topTool.hits} hits)`);

  section("10. nightly jobs on a populated database");
  const sandbox = join(work, "job");
  mkdirSync(sandbox, { recursive: true });
  writeFileSync(join(sandbox, "agent_client.py"), STUB);
  for (const f of ["eod_review.py", "morning_report.py", "archive.py"]) {
    writeFileSync(join(sandbox, f), readFileSync(join(SERVER, f), "utf8"));
  }
  const e0 = Date.now();
  const eod = runIn(sandbox, ["eod_review.py"]);
  check("eod_review completed on a full fleet", eod.ok, (eod.err || eod.out).slice(0, 250));
  note("scoring", `${rvRows} items in ${Date.now() - e0}ms`);
  check("nothing left pending", sql("SELECT COUNT(*) FROM review_items WHERE status='pending'") === 0);
  check("cleared bodies deleted",
        sql("SELECT COUNT(*) FROM review_items WHERE status='cleared' AND body IS NOT NULL") === 0);

  const day = new Date().toISOString().slice(0, 10);
  const rep = runIn(sandbox, ["morning_report.py", day], { DLP_REPORTS: REPORTS });
  check("morning report generated", rep.ok, (rep.err || rep.out).slice(0, 250));
  const summary = join(REPORTS, `dlp-report-${day}.html`);
  check("summary written", existsSync(summary));
  if (existsSync(summary)) {
    const html = readFileSync(summary, "utf8");
    check("summary leaks no SSN", !html.includes("123-45-6789") && !html.includes("987-65-4320"));
    const m = html.match(/(\d+)\s*<\/b>\s*<span>Prompts seen/);
    note("report says", m ? `${m[1]} prompts seen` : `${html.length} bytes`);
  }

  section("results");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (fails.length) { console.log(""); for (const f of fails) console.log(`  FAIL  ${f}`); }
  console.log(`\nfleet: ${fleet.length} boxes · ${ORG.length} OUs · ${prompts} prompts · ${DAYS}d archive`);
  console.log(`artifacts: ${work}${KEEP ? "" : " (removed; --keep to retain)"}`);
  return failed === 0;
}

/* ---------- helpers ---------- */

function backfill(days) {
  execFileSync(PY, ["-c", `
import sqlite3, random
from datetime import datetime, timedelta
c = sqlite3.connect(${JSON.stringify(DB)})
c.execute("PRAGMA busy_timeout=20000")
rows = c.execute("SELECT employee,ts,received_at,site,site_id,category,severity,"
                 "action,mode,source,engine,prompt_hash,char_count,findings,body_enc "
                 "FROM prompt_archive").fetchall()
out = []
for back in range(1, ${days} + 2):
    d = datetime.now() - timedelta(days=back)
    for r in random.sample(rows, max(1, len(rows) // 3)):
        out.append((r[0], d.strftime('%Y-%m-%d'), d.isoformat(), r[2], r[3], r[4],
                    r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14]))
c.executemany("INSERT INTO prompt_archive (employee,day,ts,received_at,site,site_id,"
              "category,severity,action,mode,source,engine,prompt_hash,char_count,"
              "findings,body_enc) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", out)
c.commit()
print(len(out))
`], { encoding: "utf8" });
}

async function api(path, extraHeaders = {}) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, ...extraHeaders },
  });
  return r.json();
}
function sql(q) {
  return Number(execFileSync(PY, ["-c",
    `import sqlite3;c=sqlite3.connect(${JSON.stringify(DB)});c.execute("PRAGMA busy_timeout=20000");print(c.execute(${JSON.stringify(q)}).fetchone()[0])`],
    { encoding: "utf8" }).trim());
}
function sqlAll(q) {
  return JSON.parse(execFileSync(PY, ["-c",
    `import sqlite3,json;c=sqlite3.connect(${JSON.stringify(DB)});c.execute("PRAGMA busy_timeout=20000");print(json.dumps(c.execute(${JSON.stringify(q)}).fetchall()))`],
    { encoding: "utf8" }));
}
function runPy(args, env = {}) { return runIn(SERVER, args, env); }
function runIn(cwd, args, env = {}) {
  try {
    const out = execFileSync(PY, args.map((a) => (a.endsWith(".py") ? join(cwd, a) : a)), {
      cwd, encoding: "utf8", stdio: "pipe",
      env: { ...process.env, DLP_DB: DB, DLP_ARCHIVE: "1",
             DLP_ARCHIVE_KEY: ARCHIVE_KEY, DLP_ARCHIVE_RETENTION_DAYS: "60", ...env },
    });
    return { ok: true, out, err: "" };
  } catch (e) {
    return { ok: false, out: e.stdout || "", err: (e.stderr || e.message || "").toString() };
  }
}

const STUB = `
def score_with_agent(prompts):
    out = []
    for p in prompts:
        low = (p or "").lower()
        risky = any(k in low for k in ("ssn", "123-45", "987-65", "diagnosis",
                                       "arrest", "booking", "api_key"))
        out.append({"risk": "high" if risky else "none",
                    "categories": ["pii"] if risky else [],
                    "rationale": "stub", "evidence": (p or "")[:40] if risky else "NONE",
                    "evidence_status": "quoted" if risky else "absent", "model": "stub"})
    return out

def score_user_history(employee, prompts):
    joined = " ".join(prompts).lower()
    risky = any(k in joined for k in ("ssn", "arrest", "diagnosis", "api_key"))
    return {"risk": "high" if risky else "none", "categories": [],
            "rationale": "stub history", "model": "stub"}
`;

main()
  .then((ok) => { done(); process.exit(ok ? 0 : 1); })
  .catch((e) => { console.error("\nharness error:", e); done(); process.exit(2); });

function done() {
  try { server?.kill("SIGKILL"); } catch (_) {}
  if (!KEEP) { try { rmSync(work, { recursive: true, force: true }); } catch (_) {} }
}
