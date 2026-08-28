resource "cloudflare_zero_trust_access_policy" "hub_owner" {
  account_id = var.cloudflare_account_id
  name       = "activity-hub owner"
  decision   = "allow"

  include = [{
    email = {
      email = "bvdrucker@gmail.com"
    }
  }]
}

import {
  to = cloudflare_zero_trust_access_policy.hub_owner
  id = "72bdc77341dc52a3cf4a94097f9ad96f/4a5528c8-2bc2-4d8c-b8d5-b7134b5c7f28"
}

resource "cloudflare_zero_trust_access_service_token" "hub" {
  account_id = var.cloudflare_account_id
  name       = "activity-hub automation"
}

# Access ids carry an `accounts/` prefix that the DNS record and the workers
# route do not. Cloudflare hands back the client secret once, at create, so the
# import adopts the token without it. The header value already deployed keeps
# working, and only a rotation puts a readable secret back in state.
import {
  to = cloudflare_zero_trust_access_service_token.hub
  id = "accounts/72bdc77341dc52a3cf4a94097f9ad96f/b2abbe4d-5586-4fee-b8c1-457d10485be4"
}

# Service tokens carry no identity, so they need a policy that asks for none.
resource "cloudflare_zero_trust_access_policy" "hub_automation" {
  account_id = var.cloudflare_account_id
  name       = "activity-hub automation"
  decision   = "non_identity"

  include = [{
    service_token = {
      token_id = cloudflare_zero_trust_access_service_token.hub.id
    }
  }]
}

import {
  to = cloudflare_zero_trust_access_policy.hub_automation
  id = "72bdc77341dc52a3cf4a94097f9ad96f/90146498-b99b-476b-bf23-3abdd3491847"
}

# Access matches on hostname and path prefix, so /webhooks stays reachable by
# being covered by no application at all. Strava and Wahoo post to it server to
# server and would fail any challenge.
resource "cloudflare_zero_trust_access_application" "hub_admin" {
  account_id       = var.cloudflare_account_id
  name             = "activity-hub admin"
  domain           = "${cloudflare_dns_record.hub.name}/admin"
  type             = "self_hosted"
  session_duration = "24h"

  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.hub_owner.id
      precedence = 1
    },
    {
      id         = cloudflare_zero_trust_access_policy.hub_automation.id
      precedence = 2
    },
  ]
}

import {
  to = cloudflare_zero_trust_access_application.hub_admin
  id = "accounts/72bdc77341dc52a3cf4a94097f9ad96f/0bbf69f9-b54f-4b13-b7b9-b2ffc33dec60"
}

# The OAuth callbacks land here as browser navigations, so the owner policy
# alone covers them. Nothing automated hits /auth.
resource "cloudflare_zero_trust_access_application" "hub_auth" {
  account_id       = var.cloudflare_account_id
  name             = "activity-hub auth"
  domain           = "${cloudflare_dns_record.hub.name}/auth"
  type             = "self_hosted"
  session_duration = "24h"

  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.hub_owner.id
      precedence = 1
    },
  ]
}

import {
  to = cloudflare_zero_trust_access_application.hub_auth
  id = "accounts/72bdc77341dc52a3cf4a94097f9ad96f/8737c874-5c6b-4a1e-b89e-248bd2a9533c"
}
