resource "cloudflare_dns_record" "hub" {
  zone_id = var.cloudflare_zone_id
  name    = var.hostname
  type    = "A"
  content = "192.0.2.1" # RFC 5737 TEST-NET-1 placeholder IP, actual traffic handled by Cloudflare proxy
  ttl     = 1
  proxied = true
}

import {
  to = cloudflare_dns_record.hub
  id = "c783f775892feb7781197c65222d9612/9b8c3efbca77be34a0a297d4ed834c63"
}
