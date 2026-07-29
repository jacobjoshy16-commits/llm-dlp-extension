"""
60-day prompt archive.

WHAT THIS IS, STATED PLAINLY
----------------------------
Every prompt every employee submits to an AI service, in full, readable, for 60
days. The README calls this out as the thing NOT to build:

    "If you forward full prompt text for server-side classification, your event
     database becomes a searchable archive of every SSN and case file an
     employee ever pasted -- a higher-value target than the thing you were
     protecting."

That warning is still correct. This module exists because a records-retention
obligation overrides it, not because the objection went away. Everything below
is an attempt to make a thing that should not exist as survivable as possible.

If the retention requirement is ever satisfied by metadata alone, delete this
file. That is the better outcome and it should stay on the table.

WHAT MAKES IT DEFENSIBLE
------------------------
1. ENCRYPTED AT REST, separately from the operational database. AES-256-GCM
   with a key that lives outside the DB file. A stolen dlp.db is then a list of
   hashes and timestamps, not a corpus of resident PII. Without this the backup
   tape IS the breach.

2. NO BULK READ PATH. There is deliberately no "dump all prompts" API and no
   "search everyone's history" endpoint. Reads are per-employee, require a
   reason string, and are capped. An archive you can grep is an archive that
   will be grepped.

3. EVERY READ IS LOGGED, to a table this module cannot delete from. The access
   log outlives the data it describes -- when the prompts purge at 60 days, the
   record of who read them stays. That is what makes "who looked at my prompts"
   answerable, which is the question an employee, a union, or a court will ask.

4. HARD DELETE AT 60 DAYS, whether or not anyone reviewed. Retention is a
   ceiling, not a target -- the same discipline eod_review.py already applies to
   flagged bodies. Purge runs unconditionally and VACUUMs so the plaintext is
   actually gone from the file rather than merely unlinked.

5. LEGAL HOLD as an explicit, logged exception. A hold suspends purge for named
   employees. It is deliberately awkward: it must be named, reasoned, and it
   shows up in the retention report until lifted. A silent indefinite hold is
   how a 60-day policy quietly becomes forever.

SCALE
-----
SQLite with WAL handles a few hundred workstations at this retention. Past
that, see the ceiling estimate in retention_stats() -- it reports projected
size and warns before the box becomes the problem. The storage interface here
is narrow (put/get/purge) specifically so a Postgres backend can replace it
without touching callers.
"""

import base64
import hashlib
import json
import os
import sqlite3
import zlib
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

DB = Path(os.environ.get("DLP_DB", "/var/lib/dlp/dlp.db"))

# Retention window. 60 days is the configured default; the value that matters
# legally is whatever the county's records schedule says, so it is an env var
# rather than a constant someone has to find in code.
RETENTION_DAYS = int(os.environ.get("DLP_ARCHIVE_RETENTION_DAYS", "60"))

# Off unless explicitly enabled. Storing full prompt text is a policy decision
# with legal consequences, and it should never be something a deployment
# acquires by upgrading.
ENABLED = os.environ.get("DLP_ARCHIVE", "").lower() in ("1", "true", "yes", "on")

# Compress before encrypting. Prompts are text and compress ~3-5x, which
# matters at 60 days of full capture. Order is deliberate: compressing
# ciphertext accomplishes nothing.
COMPRESS_MIN = 256

_key_cache = None


class ArchiveError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# key handling
# --------------------------------------------------------------------------

def _key() -> bytes:
    """Load the AES key from outside the database.

    Deliberately NOT stored in the DB, and deliberately not derived from
    anything guessable. If the key sits next to the ciphertext, encryption at
    rest protects against exactly one threat -- someone stealing the disk but
    not the filesystem -- which is not a threat model anyone actually has.

    Production: /etc/dlp/archive.key, 0400, owned by the dlp service account,
    excluded from backups that leave the box. Generate with:

        head -c 32 /dev/urandom | base64 > /etc/dlp/archive.key
        chmod 400 /etc/dlp/archive.key && chown dlp:dlp /etc/dlp/archive.key

    Losing this key makes the archive unreadable. That is the intended failure
    mode: unreadable is a far better outcome than readable-by-whoever-got-in.
    """
    global _key_cache
    if _key_cache is not None:
        return _key_cache

    raw = os.environ.get("DLP_ARCHIVE_KEY")
    if not raw:
        path = Path(os.environ.get("DLP_ARCHIVE_KEY_FILE", "/etc/dlp/archive.key"))
        if not path.exists():
            raise ArchiveError(
                f"archive enabled but no key: set DLP_ARCHIVE_KEY or create {path}. "
                "Refusing to store prompt text in plaintext."
            )
        raw = path.read_text().strip()

    try:
        key = base64.b64decode(raw)
    except Exception as exc:
        raise ArchiveError(f"archive key is not valid base64: {exc}") from exc
    if len(key) != 32:
        raise ArchiveError(f"archive key must be 32 bytes (got {len(key)})")
    _key_cache = key
    return key


def _aesgcm():
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as exc:
        raise ArchiveError(
            "archive requires the 'cryptography' package: pip install cryptography"
        ) from exc
    return AESGCM(_key())


def encrypt(text: str) -> bytes:
    """Compress, then encrypt. Returns nonce || ciphertext."""
    data = text.encode("utf-8")
    flag = b"\x00"
    if len(data) >= COMPRESS_MIN:
        packed = zlib.compress(data, 6)
        if len(packed) < len(data):
            data, flag = packed, b"\x01"
    nonce = os.urandom(12)
    return nonce + flag + _aesgcm().encrypt(nonce, data, None)


def decrypt(blob: bytes) -> str:
    nonce, flag, payload = blob[:12], blob[12:13], blob[13:]
    data = _aesgcm().decrypt(nonce, payload, None)
    if flag == b"\x01":
        data = zlib.decompress(data)
    return data.decode("utf-8", errors="replace")


# --------------------------------------------------------------------------
# schema
# --------------------------------------------------------------------------

def db():
    conn = sqlite3.connect(DB)
    conn.execute("PRAGMA journal_mode=WAL")
    # Enterprise scale: several workstations may flush concurrently and SQLite
    # serializes writers. Without a busy timeout those collide as
    # "database is locked" and the extension retries the whole batch.
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


def init():
    with closing(db()) as c:
        c.executescript(
            """
            /* One row per prompt. body_enc is AES-256-GCM ciphertext; there is
               no plaintext column, by design -- a nullable plaintext column is
               an invitation for a future code path to populate it. */
            CREATE TABLE IF NOT EXISTS prompt_archive (
              id INTEGER PRIMARY KEY,
              employee TEXT NOT NULL,
              day TEXT NOT NULL,            -- local YYYY-MM-DD, the purge key
              ts TEXT NOT NULL,             -- ISO-8601 UTC instant
              received_at TEXT NOT NULL,
              site TEXT, site_id TEXT, category TEXT,
              severity TEXT, action TEXT, mode TEXT, source TEXT,
              engine TEXT,
              prompt_hash TEXT,
              char_count INTEGER,
              findings TEXT,                -- JSON, rule ids + redacted samples
              body_enc BLOB,                -- encrypted; NULL once purged
              purged_at TEXT
            );

            /* Purge scans by day; per-user reads filter by employee. Both need
               an index or a 60-day table turns every query into a full scan. */
            CREATE INDEX IF NOT EXISTS idx_arch_day ON prompt_archive(day);
            CREATE INDEX IF NOT EXISTS idx_arch_emp ON prompt_archive(employee, day);
            CREATE INDEX IF NOT EXISTS idx_arch_live
              ON prompt_archive(day) WHERE body_enc IS NOT NULL;

            /* Access log. Append-only by convention and by the absence of any
               delete path in this module. It must outlive the data. */
            CREATE TABLE IF NOT EXISTS archive_access (
              id INTEGER PRIMARY KEY,
              at TEXT NOT NULL,
              actor TEXT NOT NULL,          -- who asked
              subject TEXT,                 -- whose prompts
              reason TEXT NOT NULL,         -- required, free text
              rows_returned INTEGER,
              day_from TEXT, day_to TEXT,
              decrypted INTEGER DEFAULT 0   -- 1 if plaintext was actually served
            );
            CREATE INDEX IF NOT EXISTS idx_access_at ON archive_access(at);

            /* Legal hold. Suspends purge for one employee. Deliberately
               visible: retention_stats() reports active holds so an indefinite
               one cannot hide. */
            CREATE TABLE IF NOT EXISTS legal_hold (
              id INTEGER PRIMARY KEY,
              employee TEXT NOT NULL UNIQUE,
              placed_at TEXT NOT NULL,
              placed_by TEXT NOT NULL,
              reason TEXT NOT NULL,
              released_at TEXT
            );
            """
        )
        c.commit()


# --------------------------------------------------------------------------
# write path
# --------------------------------------------------------------------------

def store(items, engine_hint=None) -> int:
    """Archive a batch of staged prompts. No-op unless explicitly enabled.

    Called from the review-batch intake alongside the existing review_items
    insert. The two are intentionally separate stores: review_items is the
    short-lived scoring queue whose bodies are deleted within minutes, and this
    is the long-lived legal record. Conflating them would mean either the queue
    never drains or the archive never fills.
    """
    if not ENABLED or not items:
        return 0

    now = datetime.now(timezone.utc).isoformat()
    rows = []
    for i in items:
        text = i.get("text")
        if not text:
            continue
        ts = i.get("ts") or now
        rows.append((
            i.get("employee") or "unattributed",
            _local_day(ts),
            ts,
            now,
            i.get("site"),
            i.get("siteId") or i.get("site"),
            i.get("category"),
            i.get("severity"),
            i.get("action"),
            i.get("mode"),
            i.get("source"),
            i.get("engine") or engine_hint,
            i.get("promptHash") or hashlib.sha256(text.encode()).hexdigest(),
            i.get("fullLength") or len(text),
            json.dumps(i.get("findings", [])),
            encrypt(text),
        ))

    if not rows:
        return 0
    with closing(db()) as c:
        c.executemany(
            "INSERT INTO prompt_archive (employee,day,ts,received_at,site,site_id,"
            "category,severity,action,mode,source,engine,prompt_hash,char_count,"
            "findings,body_enc) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
        c.commit()
    return len(rows)


def _local_day(ts: str) -> str:
    """Bucket by the server's LOCAL day.

    morning_report.py already documents why: a 7pm CT prompt is
    2026-07-22T00:xx UTC, and bucketing on the UTC date files an evening
    prompt under tomorrow. Retention questions are asked in local days, so
    purge has to agree with the reports.
    """
    with closing(db()) as c:
        row = c.execute("SELECT date(?, 'localtime')", (ts,)).fetchone()
    return row[0] if row and row[0] else ts[:10]


# --------------------------------------------------------------------------
# read path -- narrow on purpose
# --------------------------------------------------------------------------

MAX_ROWS = int(os.environ.get("DLP_ARCHIVE_MAX_ROWS", "500"))


def history(employee, actor, reason, day_from=None, day_to=None,
            include_text=False, limit=MAX_ROWS):
    """One employee's prompt history. Logged, capped, reason required.

    There is no all-employee variant and no free-text search, deliberately.
    Both are trivial to add and both convert this from a retention store into
    a surveillance tool -- the distinction is a read path that forces you to
    name a subject and a reason before you see anything.

    include_text=False (the default) returns metadata only. Getting plaintext
    is a separate, separately-logged decision, because most questions
    ("how often, which tools, what fired") do not need it.
    """
    if not employee:
        raise ArchiveError("employee is required -- there is no bulk read")
    if not actor or not reason or not str(reason).strip():
        raise ArchiveError("actor and reason are required for archive access")

    limit = max(1, min(int(limit), MAX_ROWS))
    where = ["employee = ?"]
    args = [employee]
    if day_from:
        where.append("day >= ?"); args.append(day_from)
    if day_to:
        where.append("day <= ?"); args.append(day_to)

    sql = (
        "SELECT id, day, ts, site, site_id, category, severity, action, source, "
        "engine, prompt_hash, char_count, findings, body_enc, purged_at "
        f"FROM prompt_archive WHERE {' AND '.join(where)} "
        "ORDER BY ts DESC LIMIT ?"
    )
    args.append(limit)

    with closing(db()) as c:
        rows = c.execute(sql, args).fetchall()
        c.execute(
            "INSERT INTO archive_access (at,actor,subject,reason,rows_returned,"
            "day_from,day_to,decrypted) VALUES (?,?,?,?,?,?,?,?)",
            (datetime.now(timezone.utc).isoformat(), actor, employee,
             str(reason)[:500], len(rows), day_from, day_to,
             1 if include_text else 0),
        )
        c.commit()

    out = []
    for r in rows:
        item = {
            "id": r[0], "day": r[1], "ts": r[2], "site": r[3], "siteId": r[4],
            "category": r[5], "severity": r[6], "action": r[7], "source": r[8],
            "engine": r[9], "promptHash": r[10], "charCount": r[11],
            "findings": json.loads(r[12] or "[]"),
            "purged": r[14] is not None or r[13] is None,
        }
        if include_text and r[13] is not None:
            try:
                item["text"] = decrypt(r[13])
            except Exception as exc:
                # A decryption failure is a key problem, not a data problem.
                # Say so rather than returning an empty string that reads as
                # "the employee submitted nothing".
                item["text"] = None
                item["error"] = f"decrypt failed: {type(exc).__name__}"
        out.append(item)
    return out


# --------------------------------------------------------------------------
# retention
# --------------------------------------------------------------------------

def purge(dry_run=False) -> dict:
    """Delete prompt text older than the retention window.

    Rows are KEPT with body_enc=NULL rather than deleted outright. The metadata
    (that a prompt happened, to which tool, what fired) is not the sensitive
    part, and keeping it means a retention question 90 days later can be
    answered with "it existed and was purged on this date" instead of silence.

    Legal holds are honoured and reported. VACUUM runs after a real purge so
    the plaintext is removed from the file rather than left in free pages that
    a forensic tool -- or a backup taken tomorrow -- would still surface.
    """
    if not ENABLED:
        return {"enabled": False, "purged": 0}

    cutoff_sql = f"-{RETENTION_DAYS} days"
    with closing(db()) as c:
        held = [r[0] for r in c.execute(
            "SELECT employee FROM legal_hold WHERE released_at IS NULL"
        )]
        placeholders = ",".join("?" * len(held)) if held else None

        base = ("FROM prompt_archive WHERE body_enc IS NOT NULL "
                "AND day < date('now','localtime',?)")
        args = [cutoff_sql]
        if held:
            base += f" AND employee NOT IN ({placeholders})"
            args += held

        n = c.execute(f"SELECT COUNT(*) {base}", args).fetchone()[0]
        held_back = 0
        if held:
            held_back = c.execute(
                "SELECT COUNT(*) FROM prompt_archive WHERE body_enc IS NOT NULL "
                "AND day < date('now','localtime',?) "
                f"AND employee IN ({placeholders})",
                [cutoff_sql] + held,
            ).fetchone()[0]

        if dry_run or not n:
            return {"enabled": True, "purged": 0, "would_purge": n,
                    "held": held_back, "holds": held, "dry_run": dry_run}

        c.execute(
            f"UPDATE prompt_archive SET body_enc=NULL, purged_at=? "
            f"WHERE id IN (SELECT id {base})",
            [datetime.now(timezone.utc).isoformat()] + args,
        )
        c.commit()

    # Reclaim the freed pages so the ciphertext is actually gone from disk.
    #
    # Both steps are required, and neither is sufficient alone:
    #   wal_checkpoint(TRUNCATE)  the UPDATE lands in the write-ahead log
    #                             first; until the WAL is checkpointed and
    #                             truncated, the old page images -- containing
    #                             the bodies we just "purged" -- are still
    #                             sitting in dlp.db-wal.
    #   VACUUM                    rewrites the main file, releasing pages the
    #                             UPDATE freed inside it.
    #
    # Skipping either leaves a purged prompt recoverable by anyone holding the
    # key and a copy of the file, which makes the retention promise false in
    # exactly the situation it matters: a backup or a seized disk.
    #
    # Neither can run inside a transaction.
    with closing(db()) as c:
        c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        c.execute("VACUUM")

    return {"enabled": True, "purged": n, "held": held_back, "holds": held,
            "retention_days": RETENTION_DAYS}


def place_hold(employee, actor, reason):
    with closing(db()) as c:
        c.execute(
            "INSERT INTO legal_hold (employee,placed_at,placed_by,reason) "
            "VALUES (?,?,?,?) ON CONFLICT(employee) DO UPDATE SET "
            "released_at=NULL, placed_at=excluded.placed_at, "
            "placed_by=excluded.placed_by, reason=excluded.reason",
            (employee, datetime.now(timezone.utc).isoformat(), actor, str(reason)[:500]),
        )
        c.commit()
    return {"employee": employee, "held": True}


def release_hold(employee, actor):
    with closing(db()) as c:
        c.execute("UPDATE legal_hold SET released_at=? WHERE employee=? "
                  "AND released_at IS NULL",
                  (datetime.now(timezone.utc).isoformat(), employee))
        c.commit()
    return {"employee": employee, "held": False}


def retention_stats() -> dict:
    """Numbers for the retention report and for capacity planning.

    The projection matters: SQLite is fine for a few hundred workstations at
    this retention and is not fine for a few thousand. Reporting the trend
    means the ceiling is hit as a planned migration rather than as an outage.
    """
    with closing(db()) as c:
        total, live, purged = c.execute(
            "SELECT COUNT(*), SUM(body_enc IS NOT NULL), SUM(body_enc IS NULL) "
            "FROM prompt_archive"
        ).fetchone()
        employees = c.execute(
            "SELECT COUNT(DISTINCT employee) FROM prompt_archive"
        ).fetchone()[0]
        oldest, newest = c.execute(
            "SELECT MIN(day), MAX(day) FROM prompt_archive"
        ).fetchone()
        bytes_live = c.execute(
            "SELECT COALESCE(SUM(LENGTH(body_enc)),0) FROM prompt_archive "
            "WHERE body_enc IS NOT NULL"
        ).fetchone()[0]
        days_covered = c.execute(
            "SELECT COUNT(DISTINCT day) FROM prompt_archive"
        ).fetchone()[0] or 1
        holds = c.execute(
            "SELECT employee, placed_at, placed_by, reason FROM legal_hold "
            "WHERE released_at IS NULL"
        ).fetchall()
        accesses = c.execute(
            "SELECT COUNT(*) FROM archive_access WHERE at > datetime('now','-30 days')"
        ).fetchone()[0]

    per_day = bytes_live / days_covered if days_covered else 0
    projected = per_day * RETENTION_DAYS

    return {
        "enabled": ENABLED,
        "retentionDays": RETENTION_DAYS,
        "rows": total or 0,
        "withText": live or 0,
        "purged": purged or 0,
        "employees": employees or 0,
        "oldestDay": oldest,
        "newestDay": newest,
        "bytesStored": bytes_live,
        "projectedBytesAtFullRetention": int(projected),
        "projectedMB": round(projected / 1_048_576, 1),
        # SQLite stays comfortable to roughly 20GB with this access pattern.
        # Past that, move to Postgres -- the store/history/purge interface is
        # narrow precisely so that swap does not touch callers.
        "sqliteHeadroomWarning": projected > 20 * 1_073_741_824,
        "activeHolds": [
            {"employee": h[0], "placedAt": h[1], "placedBy": h[2], "reason": h[3]}
            for h in holds
        ],
        "accessesLast30Days": accesses,
    }


if __name__ == "__main__":
    import sys
    init()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "stats"
    if cmd == "purge":
        print(json.dumps(purge(dry_run="--dry-run" in sys.argv), indent=2))
    elif cmd == "stats":
        print(json.dumps(retention_stats(), indent=2))
    elif cmd == "hold" and len(sys.argv) >= 5:
        print(json.dumps(place_hold(sys.argv[2], sys.argv[3], sys.argv[4])))
    elif cmd == "release" and len(sys.argv) >= 4:
        print(json.dumps(release_hold(sys.argv[2], sys.argv[3])))
    else:
        print("usage: archive.py [stats|purge [--dry-run]|"
              "hold <employee> <actor> <reason>|release <employee> <actor>]")
