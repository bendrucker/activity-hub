# Access resolves identity in front of /admin. This is the layer underneath it:
# a bearer token the worker checks itself, so a request that carries a valid
# Access session still needs a credential the worker issued.
#
# Terraform cannot write Worker secrets, so an apply that generates a value here
# does not deploy it. The worker keeps the previous ADMIN_TOKEN until the value
# is pushed with wrangler. See the README's Access section.
resource "random_password" "hub_admin" {
  length  = 48
  special = false
}
