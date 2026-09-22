locals {
  kube_config = data.azurerm_kubernetes_cluster.aks_cluster.kube_admin_config[0]
}
