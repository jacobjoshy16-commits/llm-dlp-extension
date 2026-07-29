# County LLM Data Guard — AWS Cloud Backend

This directory contains the AWS Cloud backend architecture and deployment package for County LLM Data Guard, migrating the on-premises Linux server (`server/`) to an enterprise-grade AWS infrastructure while preserving all security, privacy, and architectural rules defined in `ARCHITECTURE.md`.

---

## Directory Overview

```
aws/
├── README.md                 # Operational guide & deployment instructions
├── terraform/                # Infrastructure-as-Code (Terraform / CDK compatible)
│   ├── main.tf               # Providers and terraform configuration
│   ├── variables.tf          # Configurable variables (VPC CIDR, region, retention, etc.)
│   ├── outputs.tf            # ALB DNS name, S3 bucket names, DB cluster endpoints
│   ├── vpc.tf                # Multi-AZ VPC, private/public subnets, PrivateLink endpoints
│   ├── db.tf                 # Amazon Aurora PostgreSQL Serverless v2 cluster & DB
│   ├── compute.tf            # AWS ECS Cluster, Fargate task definitions & CloudWatch logs
│   ├── alb.tf                # Application Load Balancer, WAF, SSL HTTPS listener
│   ├── s3.tf                 # KMS-encrypted S3 buckets for secure reviewer files & policy
│   ├── kms.tf                # AWS KMS Customer Managed Keys (Aurora, Archive, S3)
│   ├── iam.tf                # Least-privilege IAM roles (ECS execution & task roles)
│   └── eventbridge.tf        # EventBridge Scheduler rules (17:45 EOD, 07:00 Report, 03:15 Purge)
└── server/                   # AWS-optimized Python server code
    ├── config_aws.py         # Central AWS environment configuration reader
    ├── db_aws.py             # Database abstraction layer (PostgreSQL & SQLite fallback)
    ├── receiver_aws.py       # FastAPI application for ECS Fargate / Lambda
    ├── agent_client_aws.py   # AWS Bedrock / Private SageMaker VPC inference engine
    ├── eod_review_aws.py     # 17:45 CT EOD review job for EventBridge/ECS
    ├── morning_report_aws.py # 07:00 CT morning report job (Amazon SES + S3)
    ├── archive_aws.py        # Fenced 60-day archive with AWS KMS envelope encryption
    ├── requirements_aws.txt  # Python package dependencies
    ├── Dockerfile            # Multi-stage container build for ECS Fargate
    └── setup_aws.sh          # Helper script to deploy or test locally
```

---

## Architecture Principles Preserved from `ARCHITECTURE.md`

1. **Load Order Is the Architecture (Part 1)**: The 7 content scripts (`browser-compat.js`, `sites.js`, `policy.js`, `discovery.js`, `rules.js`, `conversation.js`, `content.js`) and `background.js` require zero code changes. The managed GPO schema (`enterprise/aws/policy-aws-baseline.json`) points the extension to the AWS ALB HTTPS endpoint (`https://dlp.county.gov/api`).
2. **Four Programs, One Database (Part 2)**:
   - **`receiver_aws.py`**: Runs as an ECS Fargate container behind an Application Load Balancer terminating TLS. Writes to Amazon Aurora PostgreSQL Serverless v2. Preserves safety-critical commit order (DB insert commits *before* returning `200 OK` so extension purges local queue).
   - **`eod_review_aws.py`**: Triggered by Amazon EventBridge Scheduler at 17:45 America/Chicago time (Mon–Fri). Uses `agent_client_aws.py` to evaluate prompts over **AWS PrivateLink** against **Amazon Bedrock** (or private SageMaker VPC endpoint), guaranteeing zero external data retention. Immediately NULLs prompt bodies for `cleared` items.
   - **`morning_report_aws.py`**: Triggered by EventBridge at 07:00 America/Chicago time (Tue–Sat). Emails summary report (`dlp-report-DAY.html`, zero raw PII) via **Amazon SES** and writes the full-text reviewer HTML (`dlp-review-DAY.html`) to an encrypted **Amazon S3 bucket** (`s3://county-dlp-secure-reviews/`). It is never emailed.
   - **`archive_aws.py`**: Fenced 60-day store (`DLP_ARCHIVE=1`) using **AWS KMS Customer Managed Keys** for envelope encryption (`AES-256-GCM`), strict per-employee queries logged to an append-only audit table, and daily 03:15 CT EventBridge purge.

---

## Deploying with Terraform

```bash
cd aws/terraform/
terraform init
terraform apply -var="aws_region=us-east-1" -var="environment=prod"
```

After deployment, copy the `alb_dns_name` from Terraform outputs into your enterprise Chrome/Edge managed policy JSON (`enterprise/aws/policy-aws-baseline.json`).
