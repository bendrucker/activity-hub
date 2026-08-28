variable "cloudflare_account_id" {
  description = "Cloudflare account ID. The account is managed in bendrucker/infrastructure."
  type        = string
  default     = "72bdc77341dc52a3cf4a94097f9ad96f"
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for bendrucker.me. The zone resource is managed in bendrucker/infrastructure."
  type        = string
  default     = "c783f775892feb7781197c65222d9612"
}

variable "hostname" {
  description = "Hostname the ingest Worker serves"
  type        = string
  default     = "hub.bendrucker.me"
}
