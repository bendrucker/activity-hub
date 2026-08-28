output "access_client_id" {
  description = "CF-Access-Client-Id header value for activity-hub scripts"
  value       = cloudflare_zero_trust_access_service_token.hub.client_id
}

# There is no matching client_secret output. Cloudflare returns a service
# token's secret once, at creation, so importing the token adopts it without
# that value. Incrementing client_secret_version issues a new secret and puts it
# in state, and the old one keeps working until previous_client_secret_expires_at.

output "admin_token" {
  description = "Bearer token for the activity-hub /admin routes"
  value       = random_password.hub_admin.result
  sensitive   = true
}
