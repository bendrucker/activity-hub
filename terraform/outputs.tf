output "access_client_id" {
  description = "CF-Access-Client-Id header value for activity-hub scripts"
  value       = cloudflare_zero_trust_access_service_token.hub.client_id
}

output "access_client_secret" {
  description = "CF-Access-Client-Secret header value for activity-hub scripts"
  value       = cloudflare_zero_trust_access_service_token.hub.client_secret
  sensitive   = true
}

output "admin_token" {
  description = "Bearer token for the activity-hub /admin routes"
  value       = random_password.hub_admin.result
  sensitive   = true
}
