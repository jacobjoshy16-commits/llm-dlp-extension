"""
End-of-day compliance pass.

Runs after the extensions have shipped their 17:30 batches. Pulls every pending
staged prompt, hands it to the compliance agent for a semantic read, records the
verdict, and DELETES the prompt body.

That last step is the point. The body exists on this box for minutes, not
months. What persists is the verdict and the hash.

    systemd timer at 17:45 local -- see dlp-eod.timer
"""

import json
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from agent_client import score_user_history, score_with_agent

DB = Path(os.environ.get("DLP_DB", "/var/lib/dlp/dlp.db"))
BATCH = 25

# Bodies of flagged items are kept this long so a human can actually review
# them, then purged whether or not anyone looked.
BODY_RETENTION_DAYS = int(os.environ.get("DLP_BODY_RETENTION_DAYS", "30"))


def main() -> None:
    with closing(sqlite3.connect(DB)) as c:
        rows = c.execute(
            "SELECT id, body FROM review_items WHERE status='pending' AND body IS NOT NULL"
        ).fetchall()

        if not rows:
            print("nothing pending")
            return

        # Whole-history pass first, while every body is still present. Each
        # employee's full day of prompts -- clean ones included -- goes to the
        # agent as one ordered set, which is what catches disclosure spread
        # across prompts that individually look harmless.
        history_pass(c)

        print(f"scoring {len(rows)} staged prompts")
        for i in range(0, len(rows), BATCH):
            chunk = rows[i : i + BATCH]
            try:
                verdicts = score_with_agent([r[1] for r in chunk])
            except Exception as exc:  # leave pending, retry tomorrow
                print(f"agent failed on chunk {i}: {exc}")
                continue

            for (row_id, _), verdict in zip(chunk, verdicts):
                if verdict.get("risk") == "error":
                    # Leave pending WITH its body so tomorrow's run retries it.
                    # Recording an unscored item as clean is the worst failure
                    # mode this system has.
                    continue
                # Keep the body ONLY for items a human has to adjudicate.
                # Cleared items lose their text immediately -- that is what
                # keeps the retained set small and defensible.
                keep = verdict.get("risk") == "high"
                c.execute(
                    "UPDATE review_items SET status=?, verdict=?, "
                    "body=CASE WHEN ? THEN body ELSE NULL END WHERE id=?",
                    ("needs_review" if keep else "cleared",
                     json.dumps(verdict), 1 if keep else 0, row_id),
                )
            c.commit()

        purge_expired_bodies(c)

        high = c.execute(
            "SELECT COUNT(*) FROM review_items WHERE status='needs_review' "
            "AND date(received_at,'localtime')=date('now','localtime')"
        ).fetchone()[0]

        print(f"{datetime.now(timezone.utc).isoformat()} done. high-risk today: {high}")


def history_pass(c) -> None:
    rows = c.execute(
        "SELECT COALESCE(employee,'unattributed'), ts, body FROM review_items "
        "WHERE status='pending' AND body IS NOT NULL ORDER BY ts"
    ).fetchall()
    by_user: dict[str, list[str]] = {}
    for emp, _ts, body in rows:
        by_user.setdefault(emp, []).append(body)
    if not by_user:
        return

    day = datetime.now().strftime("%Y-%m-%d")
    print(f"history pass: {len(by_user)} employees")
    for emp, prompts in by_user.items():
        verdict = score_user_history(emp, prompts)
        if verdict.get("risk") == "error":
            # No row rather than a wrong row. The per-item pass still runs and
            # the report footer already surfaces unscored work.
            print(f"  history scoring failed for {emp}: {verdict.get('rationale')}")
            continue
        c.execute(
            "INSERT OR REPLACE INTO user_reviews "
            "(day,employee,prompt_count,risk,categories,rationale,created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (day, emp, len(prompts), verdict["risk"],
             json.dumps(verdict.get("categories", [])),
             verdict.get("rationale", ""),
             datetime.now(timezone.utc).isoformat()),
        )
    c.commit()


def purge_expired_bodies(c) -> None:
    """Retention is a ceiling, not a target. Text goes whether or not a reviewer
    got to it -- an unreviewed backlog is not a reason to keep county records on
    this box indefinitely."""
    n = c.execute(
        "UPDATE review_items SET body=NULL, status='expired' "
        "WHERE body IS NOT NULL AND status='needs_review' "
        "AND received_at < datetime('now', ?)",
        (f"-{BODY_RETENTION_DAYS} days",),
    ).rowcount
    c.commit()
    if n:
        print(f"purged {n} expired bodies past {BODY_RETENTION_DAYS}d retention")


if __name__ == "__main__":
    main()