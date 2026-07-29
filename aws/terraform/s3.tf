resource "aws_s3_bucket" "secure_reviews" {
  bucket_prefix = "county-dlp-secure-reviews-${var.environment}-"
  force_destroy = false
}

resource "aws_s3_bucket_server_side_encryption_configuration" "secure_reviews_sse" {
  bucket = aws_s3_bucket.secure_reviews.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.dlp_cmk.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "secure_reviews_pab" {
  bucket = aws_s3_bucket.secure_reviews.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket" "fleet_policy" {
  bucket_prefix = "county-dlp-fleet-policy-${var.environment}-"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "fleet_policy_pab" {
  bucket = aws_s3_bucket.fleet_policy.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
