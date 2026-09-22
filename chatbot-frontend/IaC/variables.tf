variable "environment" {
  description = "The environment name will deploy the application."
  type        = string
}

variable "aks_cluster_name" {
  default     = null
  type        = string
  description = "The name of the AKS cluster used to deploy services to. Defaults to the set naming scheme with the specific resource set to `01`"
}

variable "kubernetes_namespace" {
  description = "The name of the application specific kubernetes namespace."
  type        = string
}

variable "resource_group_name" {
  description = "The name of the resource group in which all resources shall be created."
  default     = null
  type        = string
}

variable "k8s_deployment_name" {
  description = "The name of aks deployment"
  type        = string
}

variable "image_name" {
  description = "The name of the container image in the container registry."
  type        = string
}

variable "image_secrets_name" {
  description = "The name of secret to authentication with ACR"
  type        = string
}

variable "ports" {
  description = "List of ports for the service"
  type = list(object({
    name        = string
    port        = number
    target_port = number
  }))
  default = []
}

variable "image_version" {
  description = "The version tag of the container image in the container registry, defaults to `latest`"
  type        = string
}

variable "read_only_root_filesystem" {
  description = "Whether this container has a read-only root filesystem. Default is false."
  type        = bool
}

variable "node_selector" {
  description = "NodeSelector is a selector which must be true for the pod to fit on a node. Selector which must match a node's labels for the pod to be scheduled on that node"
  type        = map(string)
}
