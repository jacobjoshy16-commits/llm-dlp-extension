variable "aws_region" {
  description = "AWS region for deployment (e.g. us-east-1)"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment name (e.g., prod, staging)"
  type        = string
  default     = "prod"
}

variable "vpc_cidr" {
  description = "CIDR block for the enterprise VPC"
  type        = string
  default     = "10.100.0.0/16"
}

variable "dlp_archive_enabled" {
  description = "Whether to enable the fenced 60-day encrypted prompt archive (0 = off, 1 = on)"
  type        = number
  default     = 0
}

variable "dlp_archive_retention_days" {
  description = "Retention period in days for archived prompts"
  type        = number
  default     = 60
}

variable "bedrock_model_id" {
  description = "Amazon Bedrock Model ID for AI inference (e.g., meta.llama3-8b-instruct-v1:0 or amazon.titan-text-lite-v1)"
  type        = string
  default     = "meta.llama3-8b-instruct-v1:0"
}

variable "ses_sender_email" {
  description = "Verified Amazon SES sender email address for morning report"
  type        = string
  default     = "dlp-noreply@county.gov"
}

variable "ses_recipient_email" {
  description = "Compliance officer recipient email for morning summary report (no raw PII)"
  type        = string
  default     = "compliance-dlp@county.gov"
}
