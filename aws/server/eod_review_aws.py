"""
eod_review_aws.py -- Nightly 17:45 CT Review Pass for AWS ECS Fargate.
Performs whole-day history pass and per-item LLM scoring. Enforces immediate
body deletion for cleared items and 30-day retention ceiling for flagged items.
"""

import sys
from datetime import datetime, timezone, timedelta
from db_aws import get_db_connection
import agent_client_aws

def run_history_pass(conn):
    cur = conn.cursor()
    cur.execute("""
        SELECT employee, DATE(ts) as day, COUNT(*) as cnt
        FROM review_items
        WHERE status = 'pending'
        GROUP BY employee, DATE(ts)
    """)
    employees_days = cur.fetchall()
    
    for row in employees_days:
        emp = row["employee"]
        day = row["day"]
        cur.execute("""
            SELECT id, ts, category, mode, body
            FROM review_items
            WHERE employee = ? AND DATE(ts) = ?
            ORDER BY id ASC
        """, (emp, day))
        prompts = [dict(r) for r in cur.fetchall()]
        
        verdict = agent_client_aws.score_user_history(prompts)
        cur.execute("""
            INSERT INTO user_reviews (day, employee, risk, rationale, prompts_count)
            VALUES (?, ?, ?, ?, ?)
        """, (day, emp, verdict.get("risk", "low"), verdict.get("rationale", ""), len(prompts)))

def run_per_item_pass(conn):
    cur = conn.cursor()
    while True:
        cur.execute("""
            SELECT id, ts, employee, site_id, category, mode, body
            FROM review_items
            WHERE status = 'pending'
            ORDER BY id ASC
            LIMIT 25
        """)
        batch = cur.fetchall()
        if not batch:
            break
            
        for item in batch:
            res = agent_client_aws.score_one(item["body"], item["category"], item["site_id"], item["mode"])
            risk = res.get("risk", "low")
            
            if risk == "error":
                # Leave item pending with body for tomorrow's retry
                continue
                
            new_status = "needs_review" if risk == "high" else "cleared"
            # Immediate body purging for cleared items
            body_value = item["body"] if new_status == "needs_review" else None
            
            cur.execute("""
                UPDATE review_items
                SET status = ?, risk = ?, verdict_rationale = ?, evidence_quote = ?, body = ?
                WHERE id = ?
            """, (new_status, risk, res.get("rationale"), res.get("evidence_quote"), body_value, item["id"]))
        conn.commit()

def purge_expired_bodies(conn):
    """
    Purges bodies of needs_review items older than 30 days whether or not
    anyone looked -- retention is a ceiling, not a target.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    cur = conn.cursor()
    cur.execute("""
        UPDATE review_items
        SET body = NULL
        WHERE status = 'needs_review' AND ts < ? AND body IS NOT NULL
    """, (cutoff,))
    conn.commit()

def run_all():
    conn = get_db_connection()
    try:
        run_history_pass(conn)
        run_per_item_pass(conn)
        purge_expired_bodies(conn)
    finally:
        conn.close()

if __name__ == "__main__":
    run_all()
