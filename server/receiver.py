"""
Receiver for the LLM Data Guard extension.

Two endpoints, deliberately separated because they have different retention
rules:

  /api/events        tier 1 metadata. No prompt text. Retain per schedule.
  /api/review-batch  tier 2 staged prompt text. Retain ONLY until the
                     end-of-day agent has scored it, then delete the body.

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


def migrate():
    """Add the employee attribution column to existing databases."""
    with closing(db()) as c:
        for table in ("events", "review_items"):
            cols = [r[1] for r in c.execute(f"PRAGMA table_info({table})")]
            if "employee" not in cols:
                c.execute(f"ALTER TABLE {table} ADD COLUMN employee TEXT")
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
        )
        for e in payload.get("events", [])
    ]
    with closing(db()) as c:
        c.executemany(
            "INSERT INTO events (received_at,site,source,severity,char_count,"
            "prompt_hash,findings,ts,employee) VALUES (?,?,?,?,?,?,?,?,?)",
            rows,
        )
        c.commit()
    return {"accepted": len(rows)}


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
        )
        for i in payload.get("items", [])
    ]
    with closing(db()) as c:
        c.executemany(
            "INSERT INTO review_items (batch_id,received_at,site,source,"
            "severity,prompt_hash,ts,body,employee) VALUES (?,?,?,?,?,?,?,?,?)",
            rows,
        )
        c.commit()

    # 200 is the extension's signal to purge its local copy. Only return it
    # once the rows are committed, or you will lose the batch.
    return {"batchId": batch_id, "accepted": len(rows)}
