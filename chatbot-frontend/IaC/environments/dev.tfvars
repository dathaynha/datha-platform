# common
environment = "dev"

# AKS deployment
aks_cluster_name     = "dmp4platform01coe"
resource_group_name  = "dmp4-platform-rg"
kubernetes_namespace = "platform"
k8s_deployment_name  = "chatbot-frontend"
image_secrets_name   = "dmp4infraacr"
ports = [
  {
    name        = "http"
    port        = 80
    target_port = 80
  }
]
read_only_root_filesystem = false

node_selector = {
  "application" = "platform"
}
