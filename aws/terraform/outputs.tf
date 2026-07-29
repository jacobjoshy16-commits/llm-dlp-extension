output "alb_dns_name" {
  description = "DNS name of the AWS Application Load Balancer (use in GPO/Intune policy)"
  value       = aws_lb.dlp_alb.dns_name
}

output "db_cluster_endpoint" {
  description = "Amazon Aurora Serverless v2 PostgreSQL endpoint"
  value       = aws_rds_cluster.dlp_aurora.endpoint
}

output "reviewer_s3_bucket" {
  description = "KMS-encrypted S3 bucket storing reviewer HTML files (dlp-review-DAY.html)"
  value       = aws_s3_bucket.secure_reviews.bucket
}

output "kms_key_arn" {
  description = "AWS KMS Customer Managed Key ARN used for archive envelope encryption"
  value       = aws_kms_key.dlp_cmk.arn
}
