# The token arrives as CLOUDFLARE_API_TOKEN, a sensitive environment variable on
# the workspace. It covers Access apps, policies, and service tokens on the
# account, plus DNS and Workers routes on the bendrucker.me zone, and nothing
# else. Managing an account-scoped resource here means widening it in
# bendrucker/infrastructure first.
provider "cloudflare" {}
