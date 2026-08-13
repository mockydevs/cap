variable "aws_region" {
  type = string
}

variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production"
  }
}

variable "bucket_name" {
  type = string
}

variable "web_origins" {
  type = list(string)
  validation {
    condition     = length(var.web_origins) > 0 && alltrue([for origin in var.web_origins : can(regex("^https://", origin))])
    error_message = "At least one exact HTTPS web origin is required"
  }
}

variable "source_noncurrent_retention_days" {
  type    = number
  default = 30
  validation {
    condition     = var.source_noncurrent_retention_days >= 7
    error_message = "Keep at least seven days of non-current versions"
  }
}
