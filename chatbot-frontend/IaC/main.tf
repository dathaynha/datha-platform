module "aks_deployment" {
  source                    = "git::https://dev.azure.com/dathaynha/DatHa%20Platform/_git/terraform-components//modules/k8s_deployment"
  meta                      = null
  name                      = var.k8s_deployment_name
  environment               = var.environment
  kubernetes_namespace      = var.kubernetes_namespace
  node_selector             = var.node_selector
  image_name                = var.image_name
  image_version             = var.image_version
  image_secrets_name        = var.image_secrets_name
  ports                     = var.ports
  read_only_root_filesystem = var.read_only_root_filesystem
}
