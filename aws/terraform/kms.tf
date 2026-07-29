resource "aws_kms_key" "dlp_cmk" {
  description             = "Customer Managed Key for County LLM DLP (Aurora DB, S3 Review Reports, Archive Envelope Encryption)"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name = "dlp-${var.environment}-cmk"
  }
}

resource "aws_kms_alias" "dlp_cmk_alias" {
  name          = "alias/dlp-${var.environment}-key"
  target_key_id = aws_kms_key.dlp_cmk.key_id
}
