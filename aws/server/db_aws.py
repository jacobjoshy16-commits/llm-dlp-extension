"""
db_aws.py -- Unified Database Layer for AWS Aurora PostgreSQL & SQLite Fallback.
Provides idempotent schema initialization and connection management for the
four backend programs.
"""

import sqlite3
import os
from contextlib import contextmanager
from config_aws import DLP_DB_PATH, DLP_DB_DSN

def get_db_connection():
    """
    Returns a database connection. Falls back to SQLite WAL mode if no
    PostgreSQL DSN is specified.
    """
    db_path = DLP_DB_PATH
    db_dir = os.path.dirname(db_path)
    if db_dir and not os.path.exists(db_dir):
        try:
            os.makedirs(db_dir, exist_ok=True)
        except PermissionError:
            db_path = os.path.join(os.environ.get("TMPDIR", "/tmp"), "dlp_aws.db")
    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn

@contextmanager
def db_session():
    conn = get_db_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

def init_schema():
    """
    Idempotent schema initialization for Tier 1 events, Tier 2 review items,
    daily user review verdicts, site coverage rollup, and archive tables.
    """
    with db_session() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                employee TEXT NOT NULL,
                site_id TEXT NOT NULL,
                category TEXT NOT NULL,
                action TEXT NOT NULL,
                mode TEXT NOT NULL,
                rule_id TEXT,
                override INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS site_coverage (
                day TEXT NOT NULL,
                site_id TEXT NOT NULL,
                category TEXT NOT NULL,
                events_count INTEGER DEFAULT 0,
                blocks_count INTEGER DEFAULT 0,
                overrides_count INTEGER DEFAULT 0,
                PRIMARY KEY (day, site_id)
            );

            CREATE TABLE IF NOT EXISTS review_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                employee TEXT NOT NULL,
                site_id TEXT NOT NULL,
                category TEXT NOT NULL,
                mode TEXT NOT NULL,
                body TEXT,
                status TEXT DEFAULT 'pending',
                risk TEXT,
                verdict_rationale TEXT,
                evidence_quote TEXT
            );

            CREATE TABLE IF NOT EXISTS user_reviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                day TEXT NOT NULL,
                employee TEXT NOT NULL,
                risk TEXT NOT NULL,
                rationale TEXT,
                prompts_count INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS archived_prompts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                employee TEXT NOT NULL,
                site_id TEXT NOT NULL,
                category TEXT NOT NULL,
                mode TEXT NOT NULL,
                body_enc BLOB,
                purged_at TEXT DEFAULT NULL
            );

            CREATE TABLE IF NOT EXISTS archiveaccess (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                actor TEXT NOT NULL,
                subject_employee TEXT NOT NULL,
                reason TEXT NOT NULL,
                rows_returned INTEGER DEFAULT 0,
                decrypted INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS legal_holds (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                employee TEXT UNIQUE NOT NULL,
                placed_at TEXT NOT NULL,
                placed_by TEXT NOT NULL,
                reason TEXT NOT NULL
            );
        """)
