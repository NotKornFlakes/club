output "d1_database_id" {
  description = "Used by the deploy job to point `wrangler d1 migrations apply` at the live database."
  value       = cloudflare_d1_database.club.id
}

output "worker_name" {
  description = "The Worker's name, the first part of its workers.dev address."
  value       = cloudflare_workers_script.club.script_name
}
