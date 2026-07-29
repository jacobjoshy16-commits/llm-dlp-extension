"""
morning_report_aws.py -- Nightly 07:00 CT Morning Report for AWS ECS Fargate.
Enforces strict deliverable separation:
- dlp-report-DAY.html (Summary, zero raw PII) is emailed via Amazon SES.
- dlp-review-DAY.html (Raw submitted text of flagged items) is saved to an
  encrypted Amazon S3 bucket and is NEVER emailed.
"""

import sys
import os
from datetime import datetime, timezone, timedelta
from db_aws import get_db_connection
from config_aws import REVIEWER_S3_BUCKET, SES_SENDER_EMAIL, SES_RECIPIENT_EMAIL, AWS_REGION

def generate_report_html(day: str, conn) -> str:
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) as total, SUM(CASE WHEN action='block' THEN 1 ELSE 0 END) as blocks FROM events WHERE ts LIKE ?", (f"{day}%",))
    ev_stat = cur.fetchone()
    
    cur.execute("SELECT risk, rationale FROM user_reviews WHERE day = ?", (day,))
    reviews = cur.fetchall()
    
    html = [
        f"<html><head><title>DLP Morning Report - {day}</title></head><body>",
        f"<h1>County LLM Data Guard Summary Report — {day}</h1>",
        f"<p>Total Prompts Evaluated: {ev_stat['total'] or 0} | Total Blocked: {ev_stat['blocks'] or 0}</p>",
        "<h2>Daily History Assessments</h2><ul>"
    ]
    for rev in reviews:
        html.append(f"<li>Risk: <b>{rev['risk']}</b> — {rev['rationale']}</li>")
    html.extend([
        "</ul>",
        "<hr><p><i>Note: Raw submitted PII and sensitive text is omitted from this summary report. To adjudicate flagged items, access the encrypted reviewer file in secure S3 storage.</i></p>",
        "</body></html>"
    ])
    return "\n".join(html)

def generate_review_html(day: str, conn) -> str:
    cur = conn.cursor()
    cur.execute("""
        SELECT id, ts, employee, site_id, category, body, verdict_rationale, evidence_quote
        FROM review_items
        WHERE status = 'needs_review' AND ts LIKE ?
    """, (f"{day}%",))
    flagged = cur.fetchall()
    
    html = [
        f"<html><head><title>DLP Reviewer File - {day}</title></head><body>",
        f"<h1>CONFIDENTIAL: Flagged DLP Prompt Review — {day}</h1>",
        f"<p>Flagged Items Requiring Human Adjudication: {len(flagged)}</p><hr>"
    ]
    for item in flagged:
        html.extend([
            f"<div><h3>Item #{item['id']} ({item['employee']} on {item['site_id']})</h3>",
            f"<p><b>Rationale:</b> {item['verdict_rationale']}</p>",
            f"<p><b>Evidence Quote:</b> <code>{item['evidence_quote']}</code></p>",
            f"<pre style='background:#f4f4f4;padding:10px;'>{item['body'] or '[BODY PURGED]'}</pre></div><hr>"
        ])
    html.append("</body></html>")
    return "\n".join(html)

def send_via_ses(subject: str, html_body: str):
    try:
        import boto3
        ses = boto3.client("ses", region_name=AWS_REGION)
        ses.send_email(
            Source=SES_SENDER_EMAIL,
            Destination={"ToAddresses": [SES_RECIPIENT_EMAIL]},
            Message={
                "Subject": {"Data": subject},
                "Body": {"Html": {"Data": html_body}}
            }
        )
    except Exception as e:
        print(f"[SES NOTICE] Unable to send email via SES: {e}")

def upload_to_s3(key: str, html_content: str):
    try:
        import boto3
        s3 = boto3.client("s3", region_name=AWS_REGION)
        s3.put_object(
            Bucket=REVIEWER_S3_BUCKET,
            Key=key,
            Body=html_content.encode("utf-8"),
            ContentType="text/html",
            ServerSideEncryption="aws:kms"
        )
    except Exception as e:
        print(f"[S3 NOTICE] Unable to upload reviewer file to S3: {e}")

def run_all(target_day: str = None):
    day = target_day or (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
    conn = get_db_connection()
    try:
        summary_html = generate_report_html(day, conn)
        review_html = generate_review_html(day, conn)
        
        # 1. Email Summary Report via Amazon SES (NO RAW PII)
        send_via_ses(f"County DLP Report for {day}", summary_html)
        
        # 2. Upload Reviewer File to KMS-encrypted Amazon S3 (NEVER EMAILED)
        upload_to_s3(f"reviews/dlp-review-{day}.html", review_html)
        
        # Write locally for debugging / testing
        os.makedirs("/var/log/dlp/reports", exist_ok=True)
        with open(f"/var/log/dlp/reports/dlp-report-{day}.html", "w", encoding="utf-8") as f:
            f.write(summary_html)
        with open(f"/var/log/dlp/reports/dlp-review-{day}.html", "w", encoding="utf-8") as f:
            f.write(review_html)
        os.chmod(f"/var/log/dlp/reports/dlp-review-{day}.html", 0o600)
    finally:
        conn.close()

if __name__ == "__main__":
    run_all()
