"""
Prompt-archive tests.

Focused on the properties that carry legal weight, because those are the ones
someone will be asked to demonstrate rather than assert:

  - text is NOT readable in the database file (encryption at rest is real)
  - purge happens at exactly the retention boundary, not near it
  - purged means gone from the FILE, not merely unreachable by query
  - every read is logged, and the log outlives the data
  - legal hold suspends purge and is visible while it does
  - a bulk read path does not exist

    ./.e2e-venv/bin/python tools/e2e/archive_test.py
"""

import base64
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

WORK = Path(tempfile.mkdtemp(prefix="dlp-archive-"))
DB = WORK / "dlp.db"
KEY = base64.b64encode(os.urandom(32)).decode()

os.environ.update({
    "DLP_DB": str(DB),
    "DLP_ARCHIVE": "1",
    "DLP_ARCHIVE_KEY": KEY,
    "DLP_ARCHIVE_RETENTION_DAYS": "60",
})
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "server"))

import archive  # noqa: E402

passed = failed = 0
fails = []


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"   ok   {name}")
    else:
        failed += 1
        fails.append(f"{name}{' -- ' + detail if detail else ''}")
        print(f"   FAIL {name}{' -- ' + str(detail) if detail else ''}")


def section(s):
    print(f"\n{s}\n{'-' * len(s)}")


def item(emp, text, days_ago=0, site="chatgpt.com", severity="clean"):
    ts = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()
    return {
        "employee": emp, "text": text, "ts": ts, "site": site,
        "siteId": "openai_chatgpt", "category": "public_chat",
        "severity": severity, "action": "allow", "mode": "enforce",
        "source": "submit", "promptHash": "h" + str(abs(hash(text)))[:12],
        "fullLength": len(text), "findings": [],
    }


def on_disk() -> bytes:
    """Everything SQLite has actually written for this database.

    Reading dlp.db alone is not enough and was the bug in an earlier version of
    this test: in WAL mode a freshly written body lives in dlp.db-wal, so a
    search of the main file "passed" while the ciphertext sat in the log right
    next to it. Any of these three files could be picked up by a backup or
    handed over in discovery, so all three have to be clean.
    """
    blob = b""
    for suffix in ("", "-wal", "-shm"):
        p = Path(str(DB) + suffix)
        if p.exists():
            blob += p.read_bytes()
    return blob


def backdate(employee, days):
    """Rewrite day/ts so retention boundaries can be tested without waiting."""
    d = (datetime.now(timezone.utc) - timedelta(days=days))
    with sqlite3.connect(DB) as c:
        c.execute("UPDATE prompt_archive SET day=?, ts=? WHERE employee=?",
                  (d.strftime("%Y-%m-%d"), d.isoformat(), employee))


archive.init()

section("1. store and read back")
SECRET = "Resident SSN: 123-45-6789 for case 21-CR-004411"
n = archive.store([
    item("clerk.a@county.gov", SECRET, severity="block"),
    item("clerk.a@county.gov", "What is the homestead deadline?"),
    item("deputy.b@county.gov", "Booking number 55512 details"),
])
check("stored 3 prompts", n == 3, str(n))

rows = archive.history("clerk.a@county.gov", "analyst", "unit test")
check("per-employee read returns only that employee", len(rows) == 2, str(len(rows)))
check("metadata read does NOT include text", all("text" not in r for r in rows))

full = archive.history("clerk.a@county.gov", "analyst", "unit test", include_text=True)
check("text round-trips through encryption",
      any(r.get("text") == SECRET for r in full))

section("2. encryption at rest")
raw = on_disk()
check("PLAINTEXT NOT PRESENT ON DISK", SECRET.encode() not in raw,
      "the archive is readable on disk -- encryption is not working")
check("SSN digits not present on disk", b"123-45-6789" not in raw)
with sqlite3.connect(DB) as c:
    blob = c.execute(
        "SELECT body_enc FROM prompt_archive WHERE employee=? LIMIT 1",
        ("clerk.a@county.gov",)).fetchone()[0]
check("stored column is bytes, not text", isinstance(blob, (bytes, bytearray)))

# A wrong key must fail closed rather than return garbage.
good = archive._key_cache
archive._key_cache = os.urandom(32)
try:
    archive.decrypt(blob)
    ok = False
except Exception:
    ok = True
archive._key_cache = good
check("wrong key fails closed (no silent garbage)", ok)

section("3. access logging")
before = len(archive.history("clerk.a@county.gov", "auditor", "check log"))
with sqlite3.connect(DB) as c:
    log = c.execute(
        "SELECT actor, subject, reason, decrypted FROM archive_access "
        "ORDER BY id DESC LIMIT 1").fetchone()
check("read was logged with actor and reason",
      log[0] == "auditor" and log[1] == "clerk.a@county.gov" and log[2] == "check log")
with sqlite3.connect(DB) as c:
    dec = c.execute(
        "SELECT COUNT(*) FROM archive_access WHERE decrypted=1").fetchone()[0]
check("decryption is flagged separately in the log", dec >= 1, str(dec))

for bad, why in [((None, "a", "r"), "no employee"),
                 (("e", "", "r"), "no actor"),
                 (("e", "a", "  "), "blank reason")]:
    try:
        archive.history(*bad)
        ok = False
    except archive.ArchiveError:
        ok = True
    check(f"read refused: {why}", ok)

section("4. retention boundary")
# Deliberately SHORT: under COMPRESS_MIN and small enough that SQLite stores
# the blob inline on a single page. A large blob is split across overflow pages
# and is never byte-contiguous on disk, so a substring search cannot find it
# either before or after purge -- an earlier version of this test used a 4KB
# body and therefore "passed" no matter what purge did.
OLD_TEXT = "ancient prompt SSN 999-88-7777 marker"
archive.store([item("old.c@county.gov", OLD_TEXT)])
backdate("old.c@county.gov", 61)
archive.store([item("edge.d@county.gov", "just inside the window")])
backdate("edge.d@county.gov", 59)

with sqlite3.connect(DB) as c:
    purged_blob = c.execute(
        "SELECT body_enc FROM prompt_archive WHERE employee='old.c@county.gov'"
    ).fetchone()[0]

dry = archive.purge(dry_run=True)
check("dry run reports without deleting", dry["would_purge"] == 1, json.dumps(dry))
with sqlite3.connect(DB) as c:
    still = c.execute("SELECT COUNT(*) FROM prompt_archive "
                      "WHERE body_enc IS NOT NULL").fetchone()[0]
check("dry run changed nothing", still == 5, str(still))

res = archive.purge()
check("purged exactly the row past 60 days", res["purged"] == 1, json.dumps(res))

with sqlite3.connect(DB) as c:
    gone = c.execute("SELECT body_enc, purged_at FROM prompt_archive "
                     "WHERE employee='old.c@county.gov'").fetchone()
    kept = c.execute("SELECT body_enc FROM prompt_archive "
                     "WHERE employee='edge.d@county.gov'").fetchone()
check("expired body is NULL", gone[0] is None)
check("purge is dated", gone[1] is not None)
check("59-day-old prompt survives (boundary is exact)", kept[0] is not None)

# The raw-SSN search below would pass whether or not VACUUM ran -- the text is
# encrypted, so it was never in the file to begin with. Testing the CIPHERTEXT
# is the real check: without VACUUM the freed pages still hold it, and anyone
# with the key plus a copy of the file can recover a "purged" prompt.
check("purged ciphertext is not left on disk",
      purged_blob is not None and purged_blob not in on_disk(),
      "freed pages or the WAL still contain the encrypted body")
check("no plaintext anywhere on disk", b"999-88-7777" not in on_disk())

meta = archive.history("old.c@county.gov", "analyst", "post-purge", include_text=True)
check("metadata survives purge", len(meta) == 1)
check("purged row is marked purged", meta[0]["purged"] is True)
check("purged row yields no text", meta[0].get("text") is None)

section("5. legal hold")
archive.store([item("held.e@county.gov", "subject to litigation hold")])
backdate("held.e@county.gov", 90)
archive.place_hold("held.e@county.gov", "counsel", "Cause 2026-CV-1234")
res = archive.purge()
check("hold prevents purge", res["purged"] == 0 and res["held"] == 1, json.dumps(res))

stats = archive.retention_stats()
check("active hold is visible in stats",
      any(h["employee"] == "held.e@county.gov" for h in stats["activeHolds"]))
check("hold records who and why",
      stats["activeHolds"][0]["placedBy"] == "counsel"
      and "2026-CV" in stats["activeHolds"][0]["reason"])

archive.release_hold("held.e@county.gov", "counsel")
res = archive.purge()
check("release lets purge proceed", res["purged"] == 1, json.dumps(res))

section("6. scale posture")
stats = archive.retention_stats()
check("stats report employees", stats["employees"] >= 4, str(stats["employees"]))
check("stats project full-retention size",
      "projectedMB" in stats and stats["projectedBytesAtFullRetention"] >= 0)
check("headroom warning present", "sqliteHeadroomWarning" in stats)

big = "resident record detail. " * 400
archive.store([item(f"bulk{i}@county.gov", big) for i in range(200)])
with sqlite3.connect(DB) as c:
    stored, avg = c.execute(
        "SELECT COUNT(*), AVG(LENGTH(body_enc)) FROM prompt_archive "
        "WHERE body_enc IS NOT NULL").fetchone()
check("200-row batch stored", stored >= 200, str(stored))
check("compression is effective on prose", avg < len(big) * 0.6,
      f"avg {int(avg)}B vs {len(big)}B raw")

section("7. no bulk read path")
check("module exposes no export/search helper",
      not any(hasattr(archive, n) for n in ("export_all", "search", "all_history")))

section("8. disabled by default")
archive.ENABLED = False
check("store is a no-op when disabled", archive.store([item("x@y.gov", "hi")]) == 0)
check("purge is a no-op when disabled", archive.purge()["enabled"] is False)
archive.ENABLED = True

print(f"\n{passed} passed, {failed} failed")
for f in fails:
    print(f"  FAIL  {f}")
subprocess.run(["rm", "-rf", str(WORK)])
sys.exit(1 if failed else 0)
