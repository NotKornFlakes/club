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

variable "site_hostname" {
  description = "The site's hostname, e.g. club-booking.<subdomain>.workers.dev. From the SITE_HOSTNAME GitHub variable. Turnstile only works there."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.site_hostname))
    error_message = "site_hostname must be a plain hostname like club-booking.example.workers.dev (no https://, no path)."
  }
}

variable "demo_mode" {
  description = "A demo site with made-up data only: lighter PIN hashing (fits the Workers Free plan), a demo banner, not listed by search engines. From the DEMO_MODE GitHub variable (\"on\"). Never for the club's real site."
  type        = bool
  default     = false
}

variable "state_bucket_name" {
  description = "The R2 bucket that holds Terraform state (created by hand once; see README)."
  type        = string
  default     = "club-tfstate"
}

# ---------- Login throttling (values are private) ----------
# Supplied from GitHub secrets. Never put real values in this repo: not here, not in docs,
# not in commit messages. Terraform hides them in plan output because they're sensitive.

variable "throttle_settings" {
  description = "Login throttle settings as one JSON object (per-IP limit, alarm limits, hold time, delay). From the THROTTLE_SETTINGS GitHub secret."
  type        = string
  sensitive   = true

  # Checks the shape only, so a failed check reveals nothing about the values.
  validation {
    condition = can(jsondecode(var.throttle_settings)) && try(
      sort(keys(jsondecode(var.throttle_settings))) == sort([
        "alarm_delay_ms",
        "alarm_hold_minutes",
        "alarm_long_failures",
        "alarm_short_failures",
        "alarm_short_minutes",
        "ip_failures_per_hour",
      ]) &&
      alltrue([for value in values(jsondecode(var.throttle_settings)) : floor(value) == value && value >= 1]),
      false
    )
    error_message = "throttle_settings must be a JSON object with exactly the six expected keys, each a positive whole number (see README)."
  }
}

variable "login_flood_limit" {
  description = "Flood gate: logins allowed per IP per 60 seconds before requests are dropped. From the LOGIN_FLOOD_LIMIT GitHub secret."
  type        = number
  sensitive   = true

  validation {
    condition     = floor(var.login_flood_limit) == var.login_flood_limit && var.login_flood_limit >= 1
    error_message = "login_flood_limit must be a positive whole number."
  }
}
