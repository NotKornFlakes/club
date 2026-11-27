variable "cloudflare_account_id" {
  description = "The club's Cloudflare account ID. Comes from a GitHub secret; never committed."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character hex Cloudflare account ID."
  }
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token, scoped to this account. Comes from a GitHub secret."
  type        = string
  sensitive   = true
}

variable "state_bucket_name" {
  description = "The R2 bucket that holds Terraform state (created by hand once; see README)."
  type        = string
  default     = "club-tfstate"
}
