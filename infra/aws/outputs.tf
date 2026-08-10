output "bucket_name" {
  value = aws_s3_bucket.media.id
}

output "kms_key_arn" {
  value = aws_kms_key.media.arn
}

output "ai_credentials_kms_key_arn" {
  value = aws_kms_key.ai_credentials.arn
}

output "cloudfront_domain" {
  value = var.enable_cloudfront ? aws_cloudfront_distribution.media[0].domain_name : null
}

output "web_policy_arn" {
  value = aws_iam_policy.web.arn
}

output "media_worker_policy_arn" {
  value = aws_iam_policy.media_worker.arn
}

output "render_worker_policy_arn" {
  value = aws_iam_policy.render_worker.arn
}

output "transcription_worker_policy_arn" {
  value = aws_iam_policy.transcription_worker.arn
}

output "ai_worker_policy_arn" {
  value = aws_iam_policy.ai_worker.arn
}
