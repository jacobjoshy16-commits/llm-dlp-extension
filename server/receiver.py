"""
Receiver for the LLM Data Guard extension.

Two endpoints, deliberately separated because they have different retention
rules:

  /api/events        tier 1 metadata. No prompt text. Retain per schedule.
  /api/review-batch  tier 2 staged prompt text. Retain ONLY until the
                     end-of-day agent has scored it, then delete the body.
  /api/policy        GET. Serves fleet policy to extensions that have a
                     policyEndpoint configured. Read-only from the browser's
                     side; the file on disk is the source of truth.
  /api/coverage      GET. Which AI sites the fleet has actually been seen on,
                     including ones no catalog knew about. This is the answer
                     to "what are people using" -- a question nobody could
                     answer before discovery existed.

Run behind nginx with mTLS or an internal-only bind. This holds county data.

    pip install fastapi uvicorn
    uvicorn receiver:app --host 127.0.0.1 --port 8787
"""

import json
import os
import sqlite3
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request

DB = Path(os.environ.get("DLP_DB", "/var/lib/dlp/dlp.db"))
DB.parent.mkdir(parents=True, exist_ok=True)

# Must match server-config.js on the extension side.
TOKEN = os.environ.get("DLP_TOKEN", "dev-token-change-me")

app = FastAPI(title="LLM Data Guard receiver")


def require_token(authorization: str = Header(default="")) -> None:
    """Shared-secret gate. Stops LAN hosts injecting junk events. Not a
    substitute for mTLS once this leaves pilot."""
    if authorization.removeprefix("Bearer ").strip() != TOKEN:
        raise HTTPException(status_code=401, detail="bad or missing token")


def db():
    conn = sqlite3.connect(DB)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init():
    with closing(db()) as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS events (
              id INTEGER PRIMARY KEY,
              received_at TEXT, site TEXT, source TEXT, severity TEXT,
              char_count INTEGER, prompt_hash TEXT, findings TEXT, ts TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_events_day ON events(ts);
            CREATE TABLE IF NOT EXISTS review_items (
              id INTEGER PRIMARY KEY,
              batch_id TEXT, received_at TEXT, site TEXT, source TEXT,
              severity TEXT, prompt_hash TEXT, ts TEXT,
              body TEXT,               -- NULL after the agent scores it
              status TEXT DEFAULT 'pending',
              verdict TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_status ON review_items(status);
            CREATE TABLE IF NOT EXISTS user_reviews (
              id INTEGER PRIMARY KEY,
              day TEXT, employee TEXT, prompt_count INTEGER,
              risk TEXT, categories TEXT, rationale TEXT, created_at TEXT,
              UNIQUE(day, employee)
            );
            """
        )
        c.commit()


# Columns added after v1 shipped. Additive only -- an in-place ALTER is safe
# and a rebuild is not, because this database already holds the audit trail
# somebody will be asked to produce.
V2_COLUMNS = {
    "events": {
        "employee": "TEXT",
        "site_id": "TEXT",     # stable tool id; "chatgpt.com" and
        "site_name": "TEXT",   # "chat.openai.com" are ONE tool
        "category": "TEXT",
        "mode": "TEXT",        # enforcement mode in force at the time
        "action": "TEXT",      # allow | warn | block | override
        "engine": "TEXT",      # chrome | edge | firefox | safari | ...
        "discovered": "INTEGER",
        "exempt_count": "INTEGER",
    },
    "review_items": {
        "employee": "TEXT",
        "site_id": "TEXT",
        "site_name": "TEXT",
        "category": "TEXT",
        "mode": "TEXT",
    },
}


def migrate():
    """Additive schema migration. Runs on every boot; a no-op once applied.

    Recording the MODE alongside the event is not bookkeeping. Without it you
    cannot distinguish "we blocked 400 things" from "we would have blocked 400
    things if the group had not been in monitor" -- and those are opposite
    findings that look identical in a severity-only table.
    """
    with closing(db()) as c:
        for table, cols in V2_COLUMNS.items():
            have = {r[1] for r in c.execute(f"PRAGMA table_info({table})")}
            for name, decl in cols.items():
                if name not in have:
                    c.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
        # Coverage observations: one row per (day, tool). Separate from events
        # so the "what are people using" question does not require a scan of
        # the full event table, which grows without bound.
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS site_coverage (
              id INTEGER PRIMARY KEY,
              day TEXT, site TEXT, site_id TEXT, site_name TEXT,
              category TEXT, mode TEXT, engine TEXT,
              discovered INTEGER DEFAULT 0,
              hits INTEGER DEFAULT 0,
              first_seen TEXT, last_seen TEXT,
              UNIQUE(day, site_id)
            );
            """
        )
        c.commit()


init()
migrate()


@app.get("/health")
async def health():
    with closing(db()) as c:
        pending = c.execute(
            "SELECT COUNT(*) FROM review_items WHERE status='pending'"
        ).fetchone()[0]
    return {"ok": True, "pendingReview": pending}


@app.post("/api/events")
async def events(req: Request, _=Depends(require_token)):
    payload = await req.json()
    now = datetime.now(timezone.utc).isoformat()
    engine_hint = payload.get("engine")
    incoming = payload.get("events", [])

    rows = [
        (
            now,
            e.get("site"),
            e.get("source"),
            e.get("severity"),
            e.get("charCount"),
            e.get("promptHash"),
            json.dumps(e.get("findings", [])),
            e.get("ts"),
            e.get("employee"),
            # site_id falls back to the hostname so v1 extensions still in the
            # fleet during a staged rollout keep producing usable rows rather
            # than a column of NULLs that quietly breaks every GROUP BY.
            e.get("siteId") or e.get("site"),
            e.get("siteName") or e.get("site"),
            e.get("category"),
            e.get("mode"),
            e.get("action"),
            e.get("engine") or engine_hint,
            1 if e.get("discovered") else 0,
            e.get("exemptCount") or 0,
        )
        for e in incoming
    ]
    with closing(db()) as c:
        c.executemany(
            "INSERT INTO events (received_at,site,source,severity,char_count,"
            "prompt_hash,findings,ts,employee,site_id,site_name,category,mode,"
            "action,engine,discovered,exempt_count) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
        _record_coverage(c, incoming, engine_hint)
        c.commit()
    return {"accepted": len(rows)}


def _record_coverage(c, incoming, engine_hint) -> None:
    """Roll every event up into a per-day, per-tool coverage row.

    Why a separate table: "which AI tools is the county actually using" is the
    question that justifies the next quarter of this project, and answering it
    from the events table means a full scan over a table that grows by tens of
    thousands of rows a day. It is also the only place discovered (non-catalog)
    sites become visible as a LIST rather than as scattered event rows.
    """
    for e in incoming:
        site = e.get("site")
        if not site or site == "-":
            continue
        site_id = e.get("siteId") or site
        ts = e.get("ts") or datetime.now(timezone.utc).isoformat()
        day = ts[:10]
        c.execute(
            "INSERT INTO site_coverage "
            "(day,site,site_id,site_name,category,mode,engine,discovered,hits,"
            "first_seen,last_seen) VALUES (?,?,?,?,?,?,?,?,1,?,?) "
            "ON CONFLICT(day,site_id) DO UPDATE SET "
            "  hits = hits + 1,"
            "  last_seen = excluded.last_seen,"
            # A tool seen in more than one mode on the same day means a rollout
            # is mid-flight. Keep the LAST observed rather than the first, so
            # the row reflects where the fleet ended up.
            "  mode = excluded.mode",
            (day, site, site_id, e.get("siteName") or site, e.get("category"),
             e.get("mode"), e.get("engine") or engine_hint,
             1 if e.get("discovered") else 0, ts, ts),
        )


@app.post("/api/review-batch")
async def review_batch(req: Request, _=Depends(require_token)):
    payload = await req.json()
    batch_id = payload.get("batchId") or str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    rows = [
        (
            batch_id,
            now,
            i.get("site"),
            i.get("source"),
            i.get("severity"),
            i.get("promptHash"),
            i.get("ts"),
            i.get("text"),
            i.get("employee"),
            i.get("siteId") or i.get("site"),
            i.get("siteName") or i.get("site"),
            i.get("category"),
            i.get("mode"),
        )
        for i in payload.get("items", [])
    ]
    with closing(db()) as c:
        c.executemany(
            "INSERT INTO review_items (batch_id,received_at,site,source,"
            "severity,prompt_hash,ts,body,employee,site_id,site_name,category,"
            "mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
        c.commit()

    # 200 is the extension's signal to purge its local copy. Only return it
    # once the rows are committed, or you will lose the batch.
    return {"batchId": batch_id, "accepted": len(rows)}


# ---------------------------------------------------------------------------
# Policy distribution
# ---------------------------------------------------------------------------
#
# WHY THE SERVER SERVES POLICY AT ALL, given that group policy already exists
# and is more authoritative:
#
# Because a GPO refresh on a county network is measured in hours, and the
# scenario this exists for is "a new AI site is trending and three departments
# are already pasting into it." Waiting on a policy cycle to cover it means the
# exposure window is the cycle time.
#
# What it is NOT: an override for group policy. The extension clamps anything
# arriving here so it can tighten enforcement but never loosen it, and it
# refuses pushed rule exemptions unless managed policy explicitly opted in.
# That asymmetry is what makes this channel safe to have -- a compromised
# server can make the tool stricter and annoy people, not blind it.
#
# The file on disk is the source of truth. There is deliberately no write
# endpoint: policy changes go through whatever review process edits that file,
# not through an HTTP call that leaves no trace outside this database.

POLICY_FILE = Path(os.environ.get("DLP_POLICY_FILE", "/etc/dlp/fleet-policy.json"))


def _load_policy() -> dict:
    if not POLICY_FILE.exists():
        return {}
    try:
        doc = json.loads(POLICY_FILE.read_text())
    except Exception as exc:
        # Serving a partial or default policy on a parse error would silently
        # change enforcement fleet-wide. Serve nothing instead; the extension
        # keeps its last-known policy, which is the safe failure direction.
        print(f"[policy] {POLICY_FILE} is not valid JSON, serving nothing: {exc}")
        return {}
    return {k: v for k, v in doc.items() if not k.startswith("_")}


@app.get("/api/policy")
async def policy(_=Depends(require_token)):
    doc = _load_policy()
    if not doc:
        raise HTTPException(status_code=404, detail="no fleet policy configured")
    # Version is the file mtime. Crude, but it changes exactly when the file
    # changes, needs no bookkeeping, and survives an admin editing the file by
    # hand at 2am -- which a hand-maintained version field does not.
    version = int(POLICY_FILE.stat().st_mtime)
    return {"version": version, "policy": doc}


# ---------------------------------------------------------------------------
# Coverage
# ---------------------------------------------------------------------------


@app.get("/api/coverage")
async def coverage(days: int = 7, _=Depends(require_token)):
    """What the fleet actually touched, catalog and non-catalog alike.

    The `discovered` split is the interesting column: those are AI surfaces
    nobody put in the catalog, found heuristically. A steady trickle there is
    normal. A spike is a new tool going viral inside the organization, and it
    is the earliest signal available that coverage needs to change.
    """
    with closing(db()) as c:
        rows = c.execute(
            "SELECT site_id, site_name, category, mode, engine, discovered, "
            "       SUM(hits) AS hits, MIN(first_seen), MAX(last_seen) "
            "FROM site_coverage "
            "WHERE day >= date('now', ?) "
            "GROUP BY site_id ORDER BY hits DESC",
            (f"-{max(1, min(days, 365))} days",),
        ).fetchall()

    return {
        "days": days,
        "tools": [
            {
                "siteId": r[0], "siteName": r[1], "category": r[2],
                "mode": r[3], "engine": r[4], "discovered": bool(r[5]),
                "hits": r[6], "firstSeen": r[7], "lastSeen": r[8],
            }
            for r in rows
        ],
        "uncatalogued": [r[0] for r in rows if r[5]],
    }
