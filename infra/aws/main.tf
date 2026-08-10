data "aws_caller_identity" "current" {}

resource "aws_kms_key" "media" {
  description             = "Cap ${var.environment} media"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "RootAdministration"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
      Action    = "kms:*"
      Resource  = "*"
    }]
  })
}

resource "aws_kms_alias" "media" {
  name          = "alias/cap-${var.environment}-media"
  target_key_id = aws_kms_key.media.key_id
}

resource "aws_kms_key" "ai_credentials" {
  description             = "Cap ${var.environment} BYOK provider credentials"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "RootAdministration"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
      Action    = "kms:*"
      Resource  = "*"
    }]
  })
}

resource "aws_kms_alias" "ai_credentials" {
  name          = "alias/cap-${var.environment}-ai-credentials"
  target_key_id = aws_kms_key.ai_credentials.key_id
}

resource "aws_s3_bucket" "media" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.media.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  cors_rule {
    allowed_origins = var.web_origins
    allowed_methods = ["PUT", "GET", "HEAD"]
    allowed_headers = ["content-type", "content-length", "x-amz-checksum-sha256", "x-amz-content-sha256", "x-amz-date", "authorization", "x-amz-security-token"]
    expose_headers  = ["ETag", "x-amz-checksum-sha256"]
    max_age_seconds = 600
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket     = aws_s3_bucket.media.id
  depends_on = [aws_s3_bucket_versioning.media]

  rule {
    id     = "abort-incomplete"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 2
    }
  }
  rule {
    id     = "temporary-artifacts"
    status = "Enabled"
    filter {
      prefix = "tmp/"
    }
    expiration {
      days = 3
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
  rule {
    id     = "noncurrent-recovery-window"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.source_noncurrent_retention_days
    }
    expiration {
      expired_object_delete_marker = true
    }
  }
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.media.arn, "${aws_s3_bucket.media.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
  dynamic "statement" {
    for_each = var.enable_cloudfront ? [1] : []
    content {
      sid       = "AllowCloudFrontRead"
      actions   = ["s3:GetObject"]
      resources = ["${aws_s3_bucket.media.arn}/*"]
      principals {
        type        = "Service"
        identifiers = ["cloudfront.amazonaws.com"]
      }
      condition {
        test     = "StringEquals"
        variable = "AWS:SourceArn"
        values   = [aws_cloudfront_distribution.media[0].arn]
      }
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket = aws_s3_bucket.media.id
  policy = data.aws_iam_policy_document.bucket.json
}

locals {
  object_resource = "${aws_s3_bucket.media.arn}/workspaces/*"
  kms_write       = ["kms:GenerateDataKey", "kms:Decrypt", "kms:DescribeKey"]
}

resource "aws_iam_policy" "web" {
  name = "cap-${var.environment}-web-media"
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:PutObject", "s3:ListMultipartUploadParts", "s3:AbortMultipartUpload", "s3:GetObject"], Resource = local.object_resource },
    { Effect = "Allow", Action = local.kms_write, Resource = aws_kms_key.media.arn },
    { Effect = "Allow", Action = ["kms:Encrypt", "kms:DescribeKey"], Resource = aws_kms_key.ai_credentials.arn }
  ] })
}

resource "aws_iam_policy" "ai_worker" {
  name = "cap-${var.environment}-ai-worker"
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["kms:Decrypt", "kms:DescribeKey"], Resource = aws_kms_key.ai_credentials.arn }
  ] })
}

resource "aws_iam_policy" "media_worker" {
  name = "cap-${var.environment}-media-worker"
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = local.object_resource },
    { Effect = "Allow", Action = local.kms_write, Resource = aws_kms_key.media.arn }
  ] })
}

resource "aws_iam_policy" "render_worker" {
  name = "cap-${var.environment}-render-worker"
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = local.object_resource },
    { Effect = "Allow", Action = local.kms_write, Resource = aws_kms_key.media.arn }
  ] })
}

resource "aws_iam_policy" "transcription_worker" {
  name = "cap-${var.environment}-transcription-worker"
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.media.arn}/workspaces/*/recordings/*/playback/*" },
    { Effect = "Allow", Action = ["kms:Decrypt", "kms:DescribeKey"], Resource = aws_kms_key.media.arn }
  ] })
}

resource "aws_cloudfront_public_key" "media" {
  count       = var.enable_cloudfront ? 1 : 0
  name        = "cap-${var.environment}-playback"
  encoded_key = var.cloudfront_public_key_pem
}

resource "aws_cloudfront_key_group" "media" {
  count = var.enable_cloudfront ? 1 : 0
  name  = "cap-${var.environment}-playback"
  items = [aws_cloudfront_public_key.media[0].id]
}

resource "aws_cloudfront_origin_access_control" "media" {
  count                             = var.enable_cloudfront ? 1 : 0
  name                              = "cap-${var.environment}-media"
  description                       = "Private Cap S3 origin"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "media" {
  count           = var.enable_cloudfront ? 1 : 0
  enabled         = true
  is_ipv6_enabled = true
  origin {
    domain_name              = aws_s3_bucket.media.bucket_regional_domain_name
    origin_id                = "media"
    origin_access_control_id = aws_cloudfront_origin_access_control.media[0].id
  }
  default_cache_behavior {
    target_origin_id       = "media"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = "413f160f-01fd-4e89-9ac0-7388c1f8b4f1"
    trusted_key_groups     = [aws_cloudfront_key_group.media[0].id]
  }
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
