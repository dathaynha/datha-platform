terraform {
  backend "azurerm" {
  }

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 2.5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 2.27.0"
    }
  }
  required_version = ">= 1.0.0"
}

provider "azurerm" {
  skip_provider_registration = "true"
  features {}
}

provider "kubernetes" {
  host                   = local.kube_config["host"]
  client_certificate     = base64decode(local.kube_config["client_certificate"])
  client_key             = base64decode(local.kube_config["client_key"])
  cluster_ca_certificate = base64decode(local.kube_config["cluster_ca_certificate"])
}
