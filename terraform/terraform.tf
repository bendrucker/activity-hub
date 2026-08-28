# Applied by the `activity-hub` HCP Terraform workspace on merge to main. There
# is no local apply path.
terraform {
  cloud {
    organization = "bendrucker"

    workspaces {
      name = "activity-hub"
    }
  }

  required_version = ">= 1.5"
}
