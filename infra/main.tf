# The club booking site: one Worker (pages + /api + nightly job) and one D1 database.
# Design: docs/architecture.md, section 4.

locals {
  # worker/wrangler.json is the single source for the Worker's name, compatibility
  # date, static-file settings and cron schedule. Terraform and wrangler both read it.
  worker = jsondecode(file("${path.module}/../worker/wrangler.json"))

  # Built by `npm run build` in worker/ (wrangler bundles src/ into one file).
  bundle = "${path.module}/../worker/dist/index.js"
}

resource "cloudflare_d1_database" "club" {
  account_id = var.cloudflare_account_id
  name       = local.worker.d1_databases[0].database_name

  # Eastern North America, near the club. Only used when the database is created.
  primary_location_hint = "enam"

  # No read replicas: every read sees the latest write, which the booking rules rely on.
  read_replication = {
    mode = "disabled"
  }

  # The database holds all bookings. Terraform must never delete it.
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_workers_script" "club" {
  account_id         = var.cloudflare_account_id
  script_name        = local.worker.name
  main_module        = "index.js"
  content_file       = local.bundle
  content_sha256     = filesha256(local.bundle)
  compatibility_date = local.worker.compatibility_date

  assets = {
    directory = "${path.module}/../worker/public"
    config = {
      # Every request reaches the Worker first, so it can set headers and check logins.
      run_worker_first   = local.worker.assets.run_worker_first
      html_handling      = local.worker.assets.html_handling
      not_found_handling = local.worker.assets.not_found_handling
    }
  }

  bindings = [
    {
      type = "d1"
      name = local.worker.d1_databases[0].binding
      id   = cloudflare_d1_database.club.id
    },
    {
      type = "assets"
      name = local.worker.assets.binding
    },
  ]

  # Keep secrets set by hand with `wrangler secret put` (PEPPER, IP_HASH_KEY), so
  # their values never appear in this code or in Terraform state.
  keep_bindings = ["secret_text"]

  # Our own console logs only. Invocation logs (request details) stay off for privacy.
  observability = {
    enabled = true
    logs = {
      enabled         = true
      invocation_logs = false
    }
  }
}

# Turns on <worker-name>.<account-subdomain>.workers.dev
resource "cloudflare_workers_script_subdomain" "club" {
  account_id       = var.cloudflare_account_id
  script_name      = cloudflare_workers_script.club.script_name
  enabled          = true
  previews_enabled = false
}

# Nightly clean-up (retention), 08:00 UTC = 3 or 4 a.m. club time
resource "cloudflare_workers_cron_trigger" "nightly" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.club.script_name
  schedules   = [for cron in local.worker.triggers.crons : { cron = cron }]
}

# Keeps the Terraform state bucket's public r2.dev address switched off. The weekly
# drift check reports it if anyone turns it on in the dashboard.
resource "cloudflare_r2_managed_domain" "state_bucket_private" {
  account_id  = var.cloudflare_account_id
  bucket_name = var.state_bucket_name
  enabled     = false
}
