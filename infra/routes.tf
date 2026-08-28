# The script itself is deployed by wrangler from this repo's CI. Only the
# hostname and the route belong here.
resource "cloudflare_workers_route" "hub" {
  zone_id = var.cloudflare_zone_id
  pattern = "${cloudflare_dns_record.hub.name}/*"
  script  = "activity-hub-ingest"
}

import {
  to = cloudflare_workers_route.hub
  id = "c783f775892feb7781197c65222d9612/0f5629d62e24445396937ffa64599dec"
}
