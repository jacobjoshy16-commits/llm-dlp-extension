# Enterprise Deployment for AWS Cloud Backend

This directory contains the baseline Chrome/Edge managed schema configuration (`policy-aws-baseline.json`) for deploying County LLM Data Guard across an enterprise fleet managed by an AWS Cloud backend.

---

## 1. Zero Code Changes to Extension
The seven content scripts (`browser-compat.js`, `sites.js`, `policy.js`, `discovery.js`, `rules.js`, `conversation.js`, `content.js`) and the service worker (`background.js`) remain unmodified. All regex scanning, Luhn card validation, SSN windowing, tabular shape checks (`assessBulk`), and conversation cross-message context (`conversation.js`) run **locally on the employee's machine**.

## 2. Pointing Managed Policy to AWS ALB
Once your AWS infrastructure is deployed using Terraform (`aws/terraform/`), update `policy-aws-baseline.json` with your ALB DNS name or custom domain (`https://dlp.county.gov`):
- `endpoint`: `https://dlp.county.gov/api/events`
- `reviewEndpoint`: `https://dlp.county.gov/api/review-batch`
- `policyEndpoint`: `https://dlp.county.gov/api/policy`

## 3. Host Permissions in `manifest.json`
Rule: whatever base URL is set in `endpoint` must also appear in `manifest.json` under `host_permissions`, or Chrome/Edge will block the background worker's fetch requests and events will pile up silently in local storage (`ev:<ts>_<rand>`).

When building with `node tools/build.mjs`, ensure your target manifest covers `https://dlp.county.gov/*` (or your ALB domain).
