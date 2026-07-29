"""
receiver_aws.py -- Always-on FastAPI Receiver for AWS ECS Fargate & Lambda.
Terminates via ALB, verifies bearer token, handles Tier 1 metadata and
Tier 2 review batches with safety-critical commit ordering.
"""

import os
import json
import sqlite3
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, Header, HTTPException, status, Depends
from pydantic import BaseModel
from config_aws import DLP_TOKEN, DLP_ARCHIVE
from db_aws import get_db_connection, init_schema
import archive_aws

app = FastAPI(title="County LLM Data Guard AWS Receiver", version="2.0.0")

def verify_token(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing or invalid Bearer token")
    token = authorization.split(" ", 1)[1]
    if token != DLP_TOKEN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid token")
    return token

class EventItem(BaseModel):
    ts: str
    employee: str
    site_id: str
    category: str
    action: str
    mode: str
    rule_id: Optional[str] = None
    override: Optional[int] = 0

class ReviewItem(BaseModel):
    ts: str
    employee: str
    site_id: str
    category: str
    mode: str
    body: str

class ReviewBatchRequest(BaseModel):
    items: List[ReviewItem]

@app.on_event("startup")
def startup():
    init_schema()
    if DLP_ARCHIVE:
        archive_aws.init_archive()

@app.get("/health")
def health():
    return {"status": "ok", "archive_enabled": DLP_ARCHIVE}

@app.post("/api/events")
def receive_events(events: List[EventItem], token: str = Depends(verify_token)):
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        for ev in events:
            cur.execute("""
                INSERT INTO events (ts, employee, site_id, category, action, mode, rule_id, override)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (ev.ts, ev.employee, ev.site_id, ev.category, ev.action, ev.mode, ev.rule_id, ev.override or 0))
            
            day = ev.ts[:10]
            cur.execute("""
                INSERT INTO site_coverage (day, site_id, category, events_count, blocks_count, overrides_count)
                VALUES (?, ?, ?, 1, ?, ?)
                ON CONFLICT(day, site_id) DO UPDATE SET
                    events_count = events_count + 1,
                    blocks_count = blocks_count + excluded.blocks_count,
                    overrides_count = overrides_count + excluded.overrides_count
            """, (day, ev.site_id, ev.category, 1 if ev.action == 'block' else 0, 1 if ev.override else 0))
        conn.commit()
        return {"status": "ok", "received": len(events)}
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()

@app.post("/api/review-batch")
def receive_review_batch(batch: ReviewBatchRequest, token: str = Depends(verify_token)):
    """
    Safety-critical commit order: database insert and optional archive store
    commit BEFORE returning 200 OK so the extension can safely purge its local queue.
    """
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        for item in batch.items:
            cur.execute("""
                INSERT INTO review_items (ts, employee, site_id, category, mode, body, status)
                VALUES (?, ?, ?, ?, ?, ?, 'pending')
            """, (item.ts, item.employee, item.site_id, item.category, item.mode, item.body))
            
            if DLP_ARCHIVE:
                archive_aws.store_one(cur, item.ts, item.employee, item.site_id, item.category, item.mode, item.body)
        conn.commit()
        return {"status": "ok", "staged": len(batch.items)}
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()

@app.get("/api/policy")
def get_policy(token: str = Depends(verify_token)):
    policy_path = "/etc/dlp/fleet-policy.json"
    if os.path.exists(policy_path):
        with open(policy_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {
        "serverUrl": "https://dlp.county.gov/api",
        "defaultMode": "enforce",
        "neverScan": ["*.bank.com", "*.health.org"]
    }

@app.get("/api/coverage")
def get_coverage(token: str = Depends(verify_token)):
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT site_id, category, SUM(events_count) as total FROM site_coverage GROUP BY site_id, category")
        rows = cur.fetchall()
        return [{"site_id": r["site_id"], "category": r["category"], "total": r["total"]} for r in rows]
    finally:
        conn.close()

# Fenced 60-Day Archive Endpoints
@app.get("/api/archive/history")
def get_archive_history(
    employee: str,
    include_text: bool = False,
    actor: Optional[str] = Header(None, alias="x-dlp-actor"),
    reason: Optional[str] = Header(None, alias="x-dlp-reason"),
    token: str = Depends(verify_token)
):
    if not DLP_ARCHIVE:
        raise HTTPException(status_code=404, detail="Archive is disabled")
    if not actor or not reason:
        raise HTTPException(status_code=400, detail="x-dlp-actor and x-dlp-reason headers are required")
    return archive_aws.get_history(employee, actor, reason, include_text)

@app.get("/api/archive/access-log")
def get_archive_access_log(token: str = Depends(verify_token)):
    if not DLP_ARCHIVE:
        raise HTTPException(status_code=404, detail="Archive is disabled")
    return archive_aws.get_access_log()

@app.get("/api/archive/retention")
def get_archive_retention(token: str = Depends(verify_token)):
    if not DLP_ARCHIVE:
        raise HTTPException(status_code=404, detail="Archive is disabled")
    return archive_aws.get_retention_stats()
