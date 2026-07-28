#!/usr/bin/env node
/*
 * Manifest generator + packager.
 *
 * WHY A BUILD STEP EXISTS NOW
 * ---------------------------
 * v1 had a hand-maintained manifest with twelve hostnames typed twice
 * (host_permissions and content_scripts.matches). That is fine for twelve. At
 * ninety-plus catalog entries across four browser targets it is a guaranteed
 * source of drift: someone adds a site to one list and not the other, the
 * content script never runs, and nothing anywhere reports an error. The bug
 * is invisible until an audit asks why that site has no events.
 *
 * So the catalog in sites.js is the single source of truth and the manifests
 * are generated. If you find yourself editing a generated manifest by hand,
 * that is the bug.
 *
 * THREE BROWSER TARGETS, THREE REAL DIFFERENCES
 * ---------------------------------------------
 * chrome   MV3, service_worker background, chrome.* namespace.
 * edge     Same as chrome. Kept as a separate target because Edge's add-on
 *          store requires its own listing metadata and because Intune-managed
 *          Edge reads policy from a different registry path -- documented in
 *          enterprise/README.md, not here.
 * firefox  MV3, but background.scripts (an event page) -- Firefox has no
 *          service worker for extensions. Also needs browser_specific_settings
 *          with an explicit id, and host permissions are OPTIONAL in MV3 unless
 *          force_installed by policy.
 * safari   MV3 via xcrun safari-web-extension-converter. Emitted so the
 *          conversion has something to consume; see enterprise/README.md for
 *          the signing story, which is the actual work.
 *
 * TWO COVERAGE PROFILES
 * ---------------------
 * catalog  (default) request only the catalog origins. Narrow, defensible,
 *          reviewable by a security team, and passes store review without an
 *          argument.
 * broad    request https://*./* so discover mode can work. This WILL draw a
 *          "reads all your data on all websites" warning and store review
 *          scrutiny. Only ship it force-installed via enterprise policy, where
 *          that warning is not shown to the user. Do not put a broad build in
 *          a public store listing.
 *
 * Usage:
 *   node tools/build.mjs                              # all targets, catalog
 *   node tools/build.mjs --target firefox --coverage broad
 *   node tools/build.mjs --zip
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "extension");
const OUT = join(ROOT, "dist");

/* Load the catalog by evaluating sites.js in a throwaway global. It is written
 * to be namespace-agnostic (sets globalThis.DLP_SITES, also assigns
 * module.exports) precisely so this works without a bundler. */
function loadCatalog() {
  const code = readFileSync(join(SRC, "sites.js"), "utf8");
  const sandbox = { globalThis: {}, module: { exports: {} } };
  // eslint-disable-next-line no-new-func
  new Function("globalThis", "module", code)(sandbox.globalThis, sandbox.module);
  return sandbox.globalThis.DLP_SITES || sandbox.module.exports;
}

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] ?? true : def;
};
const has = (name) => args.includes(`--${name}`);

const COVERAGE = flag("coverage", "catalog");
const TARGETS = flag("target") ? [flag("target")] : ["chrome", "edge", "firefox", "safari"];
const VERSION = flag("version", null);

const pkg = JSON.parse(
  existsSync(join(ROOT, "package.json"))
    ? readFileSync(join(ROOT, "package.json"), "utf8")
    : '{"version":"0.2.0"}'
);

const CONTENT_FILES = [
  "browser-compat.js", "sites.js", "policy.js", "discovery.js",
  "rules.js", "conversation.js", "content.js",
];

const SHIP_FILES = [
  ...CONTENT_FILES, "background.js", "server-config.js",
  "policy_schema.json", "options.html", "options.js",
];

/* Backend origins the worker must be allowed to reach. Kept separate from the
 * AI-site list because they are the one thing an operator genuinely has to
 * edit per deployment, and burying them in a hundred-line array is how they
 * get missed. The failure mode is the one the README already warns about:
 * fetch is blocked, events queue silently, and it looks like a server outage. */
const DEFAULT_BACKEND_ORIGINS = [
  "http://127.0.0.1:8787/*",
  "http://localhost:8787/*",
  "https://dlp.internal.fortbendcountytx.gov/*",
];

/* extension/backend-origins.json is written by tools/patch_lan.py so a dev can
 * point a build at a box on the LAN without hand-editing a generated manifest.
 * Gitignored: it holds one developer's local IP, which is noise in review and
 * wrong for everyone else. */
function backendOrigins() {
  const extra = [];
  const f = join(SRC, "backend-origins.json");
  if (existsSync(f)) {
    try {
      const parsed = JSON.parse(readFileSync(f, "utf8"));
      if (Array.isArray(parsed)) extra.push(...parsed.filter((x) => typeof x === "string"));
    } catch (e) {
      console.warn(`    ! backend-origins.json is not valid JSON, ignored: ${e.message}`);
    }
  }
  return [...new Set([...DEFAULT_BACKEND_ORIGINS, ...extra])];
}

function buildManifest(target, catalog) {
  const sitePatterns = catalog.toMatchPatterns(catalog.SITES);
  const broad = COVERAGE === "broad";

  // In broad coverage the site list is redundant with https://*/* -- but keep
  // it anyway. On Firefox MV3 host permissions are optional and a user may
  // grant a specific origin without granting all-urls, and a store reviewer
  // reading the manifest can see exactly which AI services are targeted rather
  // than only a wildcard.
  const backends = backendOrigins();
  const hostPermissions = broad
    ? [...backends, "https://*/*"]
    : [...backends, ...sitePatterns];

  const contentMatches = broad ? ["https://*/*"] : sitePatterns;

  const manifest = {
    manifest_version: 3,
    name: "County LLM Data Guard",
    version: VERSION || pkg.version || "0.2.0",
    description:
      "Blocks sensitive county data from being submitted to public AI chat services.",
    minimum_chrome_version: "121",
    permissions: [
      "storage",
      "alarms",
      "idle",
      "unlimitedStorage",
      "scripting",
    ],
    optional_permissions: [],
    host_permissions: hostPermissions,
    content_scripts: [
      {
        matches: contentMatches,
        js: CONTENT_FILES,
        run_at: "document_start",
        // Broad coverage runs top-frame only. all_frames on every page in the
        // fleet means the discovery scorer runs in every ad and analytics
        // iframe on the internet -- pure cost, zero yield, and the first thing
        // anyone will blame when a machine feels slow.
        all_frames: !broad,
      },
    ],
    storage: { managed_schema: "policy_schema.json" },
    options_ui: { page: "options.html", open_in_tab: true },
  };

  if (target === "firefox") {
    // No service worker in Firefox MV3. An event page is the supported shape,
    // and it must list the same side-effect modules the worker imports because
    // classic background scripts do not honor `import`.
    manifest.background = {
      scripts: ["background.js"],
      type: "module",
      persistent: false,
    };
    manifest.browser_specific_settings = {
      gecko: {
        id: "dlp-guard@fortbendcountytx.gov",
        // 128 is the first ESR with registerContentScripts and MV3 event pages
        // both stable. Below that, dynamic registration silently no-ops and
        // the extension degrades to manifest-only coverage.
        strict_min_version: "128.0",
      },
    };
    delete manifest.minimum_chrome_version;
    // chrome.identity.getProfileUserInfo does not exist here, so requesting
    // "identity" buys nothing and adds a permission warning. Attribution comes
    // from managed policy on this target -- set workstationTag.
  } else {
    manifest.background = { service_worker: "background.js", type: "module" };
    // Chrome/Edge only. Used as fallback attribution when workstationTag is
    // unset; harmless when the profile is unsigned.
    manifest.permissions.push("identity");
  }

  if (target === "safari") {
    delete manifest.minimum_chrome_version;
    // Safari honors neither identity nor unlimitedStorage.
    manifest.permissions = manifest.permissions.filter(
      (p) => !["identity", "unlimitedStorage"].includes(p)
    );
  }

  return manifest;
}

function build(target, catalog) {
  const dir = join(OUT, `${target}-${COVERAGE}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  for (const f of SHIP_FILES) {
    const from = join(SRC, f);
    if (!existsSync(from)) {
      // server-config.js is gitignored (it holds a token). Fall back to the
      // example so a clean checkout still builds -- and say so loudly, because
      // shipping the example token to production is a real mistake to make.
      if (f === "server-config.js" && existsSync(join(SRC, "server-config.example.js"))) {
        cpSync(join(SRC, "server-config.example.js"), join(dir, f));
        console.warn(`    ! ${target}: using server-config.example.js (dev token)`);
        continue;
      }
      console.warn(`    ! ${target}: missing ${f}, skipped`);
      continue;
    }
    cpSync(from, join(dir, f));
  }

  const manifest = buildManifest(target, catalog);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const siteCount = catalog.SITES.length;
  const patternCount = manifest.content_scripts[0].matches.length;
  console.log(
    `  ${target.padEnd(8)} ${COVERAGE.padEnd(8)} ` +
    `${siteCount} sites, ${patternCount} match pattern(s) -> dist/${target}-${COVERAGE}`
  );

  if (has("zip")) {
    const zipPath = join(OUT, `${target}-${COVERAGE}.zip`);
    rmSync(zipPath, { force: true });
    try {
      execFileSync("zip", ["-qr", zipPath, "."], { cwd: dir });
      console.log(`           packaged ${zipPath.replace(ROOT + "/", "")}`);
    } catch (e) {
      console.warn(`           zip failed: ${e.message}`);
    }
  }

  return manifest;
}

/* ---------- validation ----------
 *
 * Cheap checks that catch the mistakes that are otherwise invisible until
 * deployment. Every one of these corresponds to a failure that produces NO
 * error message at runtime -- which is exactly the class of bug worth spending
 * a build step on.
 */
function validate(catalog) {
  const problems = [];
  const ids = new Set();

  for (const s of catalog.SITES) {
    if (ids.has(s.id)) problems.push(`duplicate site id: ${s.id}`);
    ids.add(s.id);
    if (!s.hosts?.length) problems.push(`${s.id}: no hosts`);
    if (!catalog.CATEGORIES[s.category]) problems.push(`${s.id}: unknown category ${s.category}`);
    for (const h of s.hosts || []) {
      if (h.includes("://")) problems.push(`${s.id}: host "${h}" must be a bare hostname`);
      if (h.includes("/")) problems.push(`${s.id}: host "${h}" must not contain a path`);
      if (h.startsWith("*") && !h.startsWith("*.")) {
        problems.push(`${s.id}: "${h}" -- wildcard must be "*." to match subdomains`);
      }
    }
    for (const p of s.paths || []) {
      if (!p.startsWith("/")) problems.push(`${s.id}: path "${p}" must start with /`);
    }
  }

  // A site listed in neverScan AND in the catalog is a contradiction that
  // resolves silently in neverScan's favor. Surface it.
  const never = [
    "*.bankofamerica.com", "*.chase.com", "*.workday.com", "*.adp.com",
  ];
  for (const s of catalog.SITES) {
    for (const h of s.hosts) {
      if (never.some((n) => catalog.hostMatches(n, h.replace(/^\*\./, "")))) {
        problems.push(`${s.id}: host ${h} collides with a default neverScan entry`);
      }
    }
  }

  return problems;
}

/* ---------- main ---------- */

const catalog = loadCatalog();
const problems = validate(catalog);
if (problems.length) {
  console.error("catalog validation failed:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`catalog: ${catalog.SITES.length} sites, ${Object.keys(catalog.CATEGORIES).length} categories`);
const byCat = {};
for (const s of catalog.SITES) byCat[s.category] = (byCat[s.category] || 0) + 1;
for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${c}`);
}
console.log("");

mkdirSync(OUT, { recursive: true });
for (const t of TARGETS) build(t, catalog);
console.log("\ndone.");
