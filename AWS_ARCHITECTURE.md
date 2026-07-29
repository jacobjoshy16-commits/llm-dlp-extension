# County LLM Data Guard — AWS Cloud Architecture & Migration Guide

---

# Start here: Why Move to AWS and How the Architecture Holds

*This guide explains how to migrate the County LLM Data Guard backend from an on-premises Linux server (`server/`) to an enterprise-grade AWS Cloud architecture (`aws/`), while preserving every security, privacy, and architectural guarantee described in `ARCHITECTURE.md`.*

---

# Part 1: The Extension — Load Order Is the Architecture (Zero Code Changes)

The seven content scripts (`browser-compat.js`, `sites.js`, `policy.js`, `discovery.js`, `rules.js`, `conversation.js`, `content.js`) and the MV3 service worker (`background.js`) require **zero code changes** to operate against the AWS backend.

## Why Load Order and Client-Side Scanning Remain Identical
1. **Local Decision Precedence**: The local 16 regex-based detector rules (`rules.js`), the `ALWAYS_ENFORCE` floor for sensitive identifiers (`policy.js`), cross-message conversation tracking (`conversation.js`), and synchronous clipboard/file inspection (`content.js`) continue to execute **100% locally on the employee's workstation**. No prompt text ever leaves the machine to determine an `allow` or `block` verdict.
2. **Endpoint Abstraction**: The background service worker (`background.js`) communicates with the backend exclusively via HTTPS REST endpoints:
   - `POST /api/events` (Tier 1 metadata rollup)
   - `POST /api/review-batch` (Tier 2 staged bodies on session lock / 17:30 local)
   - `GET /api/policy` (Fleet policy synchronization)
   - `GET /api/coverage` (Catalog and discovery coverage rollup)

## Enterprise Configuration for AWS (`policy_schema.json` & GPO)
In an AWS deployment, IT administrators update the Chrome/Edge managed schema (`policy-aws-baseline.json`) via GPO, Microsoft Intune, or macOS configuration profiles to point to the AWS Application Load Balancer (ALB) or Amazon API Gateway endpoint:

```json
{
  "serverUrl": "https://dlp.county.gov/api",
  "sharedToken": "arn:aws:secretsmanager:us-east-1:123456789012:secret:dlp-bearer-token",
  "workstationTag": "managed-aws-fleet",
  "defaultMode": "enforce"
}
```

As enforced by `server-config.js` and `manifest.json`, the AWS domain (`https://dlp.county.gov/*`) must appear in `host_permissions` so `background.js` can flush queued events without silent CORS or permission rejections.

---

# Part 2: The Server — Mapping Four Programs & One DB to AWS Native Services

In the on-premises architecture, all four backend programs (`receiver.py`, `eod_review.py`, `agent_client.py`, `morning_report.py`) and the optional archive (`archive.py`) share a single Linux VM and a WAL-mode SQLite database (`/var/lib/dlp/dlp.db`). 

In AWS, these workloads map cleanly to scalable, highly available cloud-native services:

| Component | Linux On-Premises Architecture | AWS Cloud Enterprise Architecture |
|---|---|---|
| **TLS & Routing** | Nginx (`nginx-dlp.conf`) terminating TLS on `127.0.0.1:8787` | **AWS Application Load Balancer (ALB)** with AWS WAF and ACM TLS Certificate, or **Amazon API Gateway** |
| **Database** | SQLite 3 (`/var/lib/dlp/dlp.db`, WAL mode) | **Amazon Aurora PostgreSQL Serverless v2** (Multi-AZ, encrypted at rest via AWS KMS) |
| **API Receiver** | `receiver.py` (FastAPI / uvicorn systemd service) | **AWS ECS Fargate Task** (or AWS Lambda via Mangum wrapper) running `receiver_aws.py` behind ALB |
| **AI Inference** | Local Ollama (`qwen2.5:3b`, temp 0, `num_ctx` 8192) on Linux VM | **Amazon Bedrock** via **AWS PrivateLink VPC Endpoint** (e.g., Llama 3 / Qwen / Titan) or **Amazon SageMaker Private Endpoint** |
| **17:45 EOD Review** | `eod_review.py` scheduled by `dlp-eod.timer` | **Amazon EventBridge Scheduler** triggering an **AWS ECS Fargate Task** (`eod_review_aws.py`) at 17:45 CT |
| **07:00 Morning Report** | `morning_report.py` scheduled by `dlp-report.timer` | **Amazon EventBridge Scheduler** triggering an **AWS ECS Fargate Task** (`morning_report_aws.py`) at 07:00 CT |
| **Report Distribution** | Local file writes & SMTP email | **Amazon SES** for summary report (`dlp-report-DAY.html`); **Amazon S3 (KMS Encrypted)** for reviewer file (`dlp-review-DAY.html`) |
| **Fenced 60-Day Archive** | `archive.py` with AES-256-GCM and key in `/etc/dlp/archive.key` | **Amazon Aurora / RDS** with AWS KMS Envelope Encryption (`archive_aws.py`) + **Amazon DynamoDB / CloudWatch Audit Logs** |

```
                                  +----------------------------------------------------+
                                  |         AWS Cloud (Private Enterprise VPC)         |
                                  |                                                    |
+--------------------------+      |  +--------------------+    +--------------------+  |
|  Employee Workstations   |      |  | AWS WAF + ALB /    |    |  Amazon Bedrock /  |  |
|  (7 Content Scripts +    | ====> |  | API Gateway        |    |  SageMaker Endpoint|  |
|   background.js Worker)  |      |  +---------+----------+    |  (Private VPC)     |  |
+--------------------------+      |            |               +---------^----------+  |
                                  |            v                         |             |
                                  |  +--------------------+              |             |
                                  |  | ECS Fargate Cluster| -------------+             |
                                  |  | (receiver_aws.py,  |                            |
                                  |  |  eod_review_aws.py,| --+                        |
                                  |  |  morning_report)   |   |                        |
                                  |  +---------+----------+   |    +----------------+  |
                                  |            |              +--->|   Amazon S3    |  |
                                  |            v                   | (Secure HTML   |  |
                                  |  +--------------------+        |  Review Files) |  |
                                  |  |   Amazon Aurora    |        +----------------+  |
                                  |  |    PostgreSQL      |                            |
                                  |  |  (Serverless v2)   |        +----------------+  |
                                  |  +--------------------+        |   Amazon SES   |  |
                                  |                                | (Summary Email)|  |
                                  +--------------------------------+----------------+--+
```

---

## 1. `receiver_aws.py` — The Always-On API Service
The AWS receiver is packaged as a Docker container running on **AWS ECS Fargate** (or serverless AWS Lambda) behind an Application Load Balancer.

- **Endpoints & Commit Order Security**:
  - `POST /api/events`: Inserts Tier 1 metadata and updates the `site_coverage` rollup table within a single ACID database transaction on Amazon Aurora PostgreSQL Serverless v2.
  - `POST /api/review-batch`: Inserts Tier 2 pending review items. **Commit order remains safety-critical**: database insert and optional archive store transactions commit *before* returning HTTP `200 OK` to the extension, ensuring that a transient container restart cannot cause data loss.
  - `GET /api/policy`: Serves `fleet-policy.json` from a cached S3 object or Amazon ElastiCache, clamped to managed rules.
  - `GET /api/coverage` & `GET /health`: System health and site coverage monitoring.
- **Authentication**: Bearer tokens are retrieved from **AWS Secrets Manager** (`dlp-bearer-token`) and cached in memory, or enforced at the ALB layer via AWS IAM / SSO integration.

## 2. `eod_review_aws.py` & `agent_client_aws.py` — The 17:45 Review Pass & On-Premises Privacy in AWS
Scheduled via **Amazon EventBridge Scheduler** at 17:45 America/Chicago time (Mon–Fri), the EOD review container launches on ECS Fargate and connects to `agent_client_aws.py`.

### Why Amazon Bedrock via AWS PrivateLink Satisfies the Privacy Argument
In the on-premises architecture, the cardinal rule is: *"Inference stays on-premises: shipping text to a hosted API to check whether the text was shipped to a hosted API is the self-defeating thing an auditor finds first."*

When migrating to AWS, this requirement is met through **Amazon Bedrock via AWS PrivateLink VPC Endpoints**:
1. **Zero Data Retention**: AWS Bedrock guarantees that customer prompt text is never retained, logged, or used to train AWS or third-party base models.
2. **Private Network Boundary**: By accessing Bedrock over an AWS PrivateLink VPC endpoint, prompt text never traverses the public internet or leaves the County's isolated AWS account boundary.
3. **Alternative Private Hosting**: If policy mandates self-managed weights, an **Amazon SageMaker Private Endpoint** running open-source Qwen 2.5 3B inside an isolated VPC subnet is used as a drop-in replacement.

### Preserving Scoring Logic & Safety Mechanics
- **Pass 1 (`history_pass`)**: Evaluates each employee's entire day of prompts as a unified sequence, detecting disclosures split across individually harmless prompts (`user_reviews`).
- **Pass 2 (`per-item pass`)**: Scores batches of 25 pending items with json-only risk, categories, rationale, and evidence quotes.
- **Evidence Verification**: Calls `verify_evidence()` to verify that model-cited evidence quotes are real substrings of the prompt body, preventing model hallucination without ever downgrading risk.
- **Immediate Body Purging**:
  - `cleared` items have their prompt body set to `NULL` **immediately upon scoring** ("The body exists on this box for minutes, not months").
  - `needs_review` items retain their body for human adjudication up to the 30-day ceiling.
- **Fail-Safe Retry**: Any model inference error (`risk: "error"`) leaves the item pending with its body intact for tomorrow's retry. An unscored item is never recorded as clean.

## 3. `morning_report_aws.py` — The 07:00 Deliverable Split
Scheduled via **Amazon EventBridge Scheduler** at 07:00 America/Chicago time (Tue–Sat), the report job enforces the architectural separation of deliverables:

| File | Contains | Delivery Channel | Why |
|---|---|---|---|
| `dlp-report-DAY.html` | Aggregate counts, rules fired, per-site activity, agent rationales, history assessments | **Amazon SES Email** to Compliance Inbox | Contains zero raw sensitive text; safe for email archives and mobile sync. |
| `dlp-review-DAY.html` | **Full submitted text** of flagged items (`needs_review`), mode `0600` equivalent | **Amazon S3 (`s3://county-dlp-secure-reviews/`)** with KMS Encryption | Raw sensitive text must exist for human review, but must **never leave secure server storage** via email. |

## 4. `archive_aws.py` — The Fenced 60-Day Store in AWS
When enabled (`DLP_ARCHIVE=1`), the archive stores full prompt text for up to 60 days to satisfy public records obligations:

- **At-Rest Encryption**: Uses **AWS KMS Customer Managed Keys (CMK)** (`alias/dlp-archive-key`) with envelope encryption (`AES-256-GCM`). No plaintext prompt text is ever written to any database column or unencrypted S3 object.
- **Strict Access Controls**: `history()` queries require an authenticated actor and explicit reason header, capped at 500 rows. No bulk search or "grep everyone" endpoint exists.
- **Immutable Audit Log**: Every read attempt is recorded in an append-only **Amazon DynamoDB audit table** (`dlp_archive_access_log`) or AWS CloudWatch Audit Logs (`/api/archive/access-log`), outliving the purged text.
- **Hard 60-Day Purge**: Daily EventBridge task at `03:15 CT` purges expired ciphertext and sets `body_enc = NULL`, while respecting active `legal_hold` records.

---

# Part 3: Build, Test, Deploy in AWS (The Enterprise Ring)

## Directory Structure
```
llm-dlp-extension/
├── AWS_ARCHITECTURE.md              # This document
├── aws/                             # Complete AWS Cloud Backend deployment package
│   ├── README.md                    # AWS operational instructions
│   ├── terraform/                   # Infrastructure as Code (VPC, Aurora, ECS, ALB, S3, KMS, IAM)
│   │   ├── main.tf, variables.tf, outputs.tf
│   │   ├── vpc.tf, db.tf, compute.tf, alb.tf
│   │   ├── s3.tf, kms.tf, iam.tf, eventbridge.tf
│   └── server/                      # AWS-ready Python server modules
│       ├── config_aws.py            # Central AWS settings (Aurora DSN, KMS, Bedrock, SES)
│       ├── db_aws.py                # Database abstraction (PostgreSQL & SQLite fallback)
│       ├── receiver_aws.py          # FastAPI service for AWS ECS/Lambda
│       ├── agent_client_aws.py      # AWS Bedrock / SageMaker private inference client
│       ├── eod_review_aws.py        # 17:45 CT EOD review job for ECS Fargate
│       ├── morning_report_aws.py    # 07:00 CT morning report job (SES + S3)
│       ├── archive_aws.py           # AWS KMS envelope-encrypted 60-day archive
│       └── Dockerfile               # Multi-stage Docker container build for ECS
├── enterprise/
│   └── aws/                         # Enterprise policy configurations for AWS ALB endpoint
│       ├── README.md
│       └── policy-aws-baseline.json
```

## Infrastructure as Code (Terraform / AWS CDK)
The `aws/terraform/` module provisions all necessary resources with enterprise-grade hardening:
1. **Multi-AZ VPC**: Private subnets for compute (ECS) and database (Aurora Serverless v2); public subnets strictly for ALB with WAF.
2. **Amazon Aurora PostgreSQL Serverless v2**: Replaces SQLite `/var/lib/dlp/dlp.db`, scaling dynamically while providing automatic failover and KMS at-rest encryption.
3. **IAM Least-Privilege**: ECS task roles grant only `bedrock:InvokeModel` on authorized model ARNs, `ses:SendEmail` on verified County domains, and `kms:Decrypt`/`kms:Encrypt` on explicit key ARNs.

---

# One Message Through the Whole AWS Machine

An employee pastes a letter containing `SSN 123-45-6789` into ChatGPT and presses Enter:

1. **Local Intercept (`content.js` + `rules.js`)**: The synchronous clipboard scan matches a Social Security number pattern (`block` severity). The paste is blocked before the text enters the DOM.
2. **Keystroke Gate (`policy.js`)**: If typed, `policy.js` evaluates `ALWAYS_ENFORCE` for `ssn` and returns `BLOCK`. The keystroke never reaches the chat web page.
3. **Local UI (`content.js`)**: The Shadow DOM modal displays `"Social Security number · 12*********89"`. No override button is shown.
4. **Metadata Dispatch (`background.js`)**: An `event` payload (redacted sample, timestamp, employee attribution) is sent to `https://dlp.county.gov/api/events`.
5. **AWS ALB & ECS Receiver (`receiver_aws.py`)**: The Application Load Balancer terminates TLS and forwards to ECS Fargate. The receiver validates the bearer token from AWS Secrets Manager and inserts the record into **Amazon Aurora PostgreSQL Serverless v2** (`events` table).
6. **17:45 EOD Review (`eod_review_aws.py`)**: Amazon EventBridge triggers the EOD review ECS task. `agent_client_aws.py` sends Tier 2 prompt bodies over an **AWS PrivateLink VPC endpoint** to **Amazon Bedrock**. Items marked `cleared` have their body set to `NULL` in Aurora immediately.
7. **07:00 Morning Report (`morning_report_aws.py`)**: Amazon EventBridge triggers the report task:
   - `dlp-report-DAY.html` (counts and rationales, no raw PII) is sent to compliance officers via **Amazon SES**.
   - `dlp-review-DAY.html` (containing raw text of `needs_review` items) is encrypted with AWS KMS and saved to `s3://county-dlp-secure-reviews/dlp-review-DAY.html`.

**The resident's SSN never left the County's AWS account boundary.** Local detection prevented the disclosure in under 1 millisecond on the employee's machine, while the AWS cloud backend provided scalable, encrypted audit record-keeping without exposing sensitive text.
