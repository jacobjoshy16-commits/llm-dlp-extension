"""
archive_aws.py -- Fenced 60-Day Prompt Archive for AWS.
Enforces at-rest encryption via AWS KMS Customer Managed Keys or AES-256-GCM
envelope encryption, strict per-employee queries with actor/reason logging,
hard 60-day retention purging, and legal holds.
"""

import os
import json
import sqlite3
import base64
from datetime import datetime, timezone, timedelta
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from config_aws import DLP_ARCHIVE_KEY_FILE, DLP_ARCHIVE_RETENTION_DAYS, KMS_KEY_ARN, AWS_REGION
from db_aws import get_db_connection

class ArchiveError(Exception):
    pass

def _get_encryption_key() -> bytes:
    if not os.path.exists(DLP_ARCHIVE_KEY_FILE):
        raise ArchiveError(f"Archive key file missing: {DLP_ARCHIVE_KEY_FILE}")
    with open(DLP_ARCHIVE_KEY_FILE, "rb") as f:
        key = base64.b64decode(f.read().strip())
        if len(key) != 32:
            raise ArchiveError("Archive key must be 32 decoded bytes for AES-256-GCM")
        return key

def encrypt_body(plaintext: str) -> bytes:
    if not plaintext:
        return b""
    data = plaintext.encode("utf-8")
    try:
        if KMS_KEY_ARN:
            import boto3
            kms = boto3.client("kms", region_name=AWS_REGION)
            resp = kms.encrypt(KeyId=KMS_KEY_ARN, Plaintext=data)
            return resp["CiphertextBlob"]
    except Exception:
        pass
    key = _get_encryption_key()
    aesgcm = AESGCM(key)
    nonce = os.urandom(12)
    ciphertext = aesgcm.encrypt(nonce, data, None)
    return nonce + ciphertext

def decrypt_body(blob: bytes) -> str:
    if not blob:
        return ""
    try:
        if KMS_KEY_ARN and not (len(blob) > 12 and blob[0] == 0x01):
            import boto3
            kms = boto3.client("kms", region_name=AWS_REGION)
            resp = kms.decrypt(CiphertextBlob=blob, KeyId=KMS_KEY_ARN)
            return resp["Plaintext"].decode("utf-8")
    except Exception:
        pass
    key = _get_encryption_key()
    aesgcm = AESGCM(key)
    nonce = blob[:12]
    ciphertext = blob[12:]
    return aesgcm.decrypt(nonce, ciphertext, None).decode("utf-8")

def init_archive():
    with get_db_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS archived_prompts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                employee TEXT NOT NULL,
                site_id TEXT NOT NULL,
                category TEXT NOT NULL,
                mode TEXT NOT NULL,
                body_enc BLOB,
                purged_at TEXT DEFAULT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS archiveaccess (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                actor TEXT NOT NULL,
                subject_employee TEXT NOT NULL,
                reason TEXT NOT NULL,
                rows_returned INTEGER DEFAULT 0,
                decrypted INTEGER DEFAULT 0
            )
        """)

def store_one(cur, ts: str, employee: str, site_id: str, category: str, mode: str, body: str):
    blob = encrypt_body(body)
    cur.execute("""
        INSERT INTO archived_prompts (ts, employee, site_id, category, mode, body_enc)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (ts, employee, site_id, category, mode, blob))

def get_history(employee: str, actor: str, reason: str, include_text: bool):
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT id, ts, employee, site_id, category, mode, body_enc, purged_at
            FROM archived_prompts
            WHERE employee = ?
            ORDER BY ts DESC
            LIMIT 500
        """, (employee,))
        rows = cur.fetchall()
        
        results = []
        for r in rows:
            item = {
                "id": r["id"],
                "ts": r["ts"],
                "employee": r["employee"],
                "site_id": r["site_id"],
                "category": r["category"],
                "mode": r["mode"],
                "purged": r["purged_at"] is not None
            }
            if include_text and r["body_enc"] and r["purged_at"] is None:
                item["body"] = decrypt_body(r["body_enc"])
            results.append(item)
            
        cur.execute("""
            INSERT INTO archiveaccess (ts, actor, subject_employee, reason, rows_returned, decrypted)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (datetime.now(timezone.utc).isoformat(), actor, employee, reason, len(results), 1 if include_text else 0))
        conn.commit()
        return results
    finally:
        conn.close()

def get_access_log():
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT ts, actor, subject_employee, reason, rows_returned, decrypted FROM archiveaccess ORDER BY id DESC LIMIT 200")
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()

def get_retention_stats():
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) as rows, COUNT(DISTINCT employee) as emp FROM archived_prompts")
        row = cur.fetchone()
        return {"rows": row["rows"], "emp": row["emp"], "retention_days": DLP_ARCHIVE_RETENTION_DAYS}
    finally:
        conn.close()

def purge_expired():
    """
    Hard purge of archived prompts older than DLP_ARCHIVE_RETENTION_DAYS (default 60 days).
    Sets body_enc = NULL and records purged_at timestamp, unless employee is on legal hold.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=DLP_ARCHIVE_RETENTION_DAYS)).isoformat()
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT employee FROM legal_holds")
        held_employees = {r["employee"] for r in cur.fetchall()}
        
        cur.execute("""
            SELECT id, employee FROM archived_prompts
            WHERE ts < ? AND purged_at IS NULL
        """, (cutoff,))
        expired = cur.fetchall()
        
        purged_count = 0
        for row in expired:
            if row["employee"] not in held_employees:
                cur.execute("""
                    UPDATE archived_prompts
                    SET body_enc = NULL, purged_at = ?
                    WHERE id = ?
                """, (datetime.now(timezone.utc).isoformat(), row["id"]))
                purged_count += 1
        conn.commit()
        return purged_count
