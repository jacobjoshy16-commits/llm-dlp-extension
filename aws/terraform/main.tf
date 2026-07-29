terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = "County-LLM-DLP"
      Environment = var.environment
      ManagedBy   = "Terraform"
      Repository  = "llm-dlp-extension"
    }
  }
}
