"""
config_aws.py -- Central AWS configuration reader for County LLM DLP backend.
Loads database connection settings, AWS KMS keys, Amazon Bedrock model ID,
and S3 bucket names from environment variables.
"""

import os

DLP_TOKEN = os.environ.get("DLP_TOKEN", "test-shared-bearer-token-placeholder")
DLP_DB_DSN = os.environ.get("DLP_DB_DSN", "")
DLP_DB_PATH = os.environ.get("DLP_DB", "/var/lib/dlp/dlp.db")

# AWS specific configurations
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "meta.llama3-8b-instruct-v1:0")
KMS_KEY_ARN = os.environ.get("KMS_KEY_ARN", "")
REVIEWER_S3_BUCKET = os.environ.get("REVIEWER_S3_BUCKET", "county-dlp-secure-reviews")
FLEET_POLICY_BUCKET = os.environ.get("FLEET_POLICY_BUCKET", "county-dlp-fleet-policy")

# Email reporting via Amazon SES
SES_SENDER_EMAIL = os.environ.get("SES_SENDER_EMAIL", "dlp-noreply@county.gov")
SES_RECIPIENT_EMAIL = os.environ.get("SES_RECIPIENT_EMAIL", "compliance-dlp@county.gov")

# Fenced 60-day archive settings
DLP_ARCHIVE = os.environ.get("DLP_ARCHIVE", "").strip() == "1"
DLP_ARCHIVE_RETENTION_DAYS = int(os.environ.get("DLP_ARCHIVE_RETENTION_DAYS", "60"))
DLP_ARCHIVE_KEY_FILE = os.environ.get("DLP_ARCHIVE_KEY_FILE", "/etc/dlp/archive.key")
