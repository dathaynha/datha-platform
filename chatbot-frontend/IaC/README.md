# Setting up a Product Specific Workspace

Setting up the infrastructure as code for a new product consist of basically 3 steps:

1. Coding the infrastructure description using one or more TF files
2. Checking in the infrastructure description into a product specific repository
3. Creating/Adapting the product's CI/CD and Release pipelines to invoke Terraform

## Coding the Infrastructure

The main benefit of using infrastructure as code is that it enables to treat changes to the infrastructure resources in
very much the same way as developed application source code. Ideally, the infrastructure setup is maintained by the
product development team itself. However, infrastructure is often a domain very different from what a product team
usually deals with. To that end the DatHa platform provides a set of Terraform modules that seek to ease the process for the
development teams and at the same time ensures use of platform infrastructure and security guidelines when creating
resources in Azure.

### Cloning necessary files

In order to get a head start, the [terraform-components repo](https://dev.azure.com/dathaynha/DatHa%20Platform/_git/terraform-components)
already contains a minimal example of an infrastructure description.

To obtain it clone the repo and go to the `.\examples\specify_project` directory.

The directory contains five files:

| File name   | Description                                                                                                                                                                           |
| ----------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| main.tf     | Contains the actual infrastructure description as well as necessary meta information.                                                                                                 |
| outputs.tf  | Specifies the output variables that are returned from terraform. **Have a look but please don't change it unless you know what you are doing.**                                       |
| provider.tf | Specifies how the underlying terraform process shall be configured and which cloud provider is chosen. **Have a look but please don't change it unless you know what you are doing.** |
| readme.md   | Provides the content of the Wiki page you are currently looking at.                                                                                                                   |
| variable.tf | Specifies the input variables that fed into terraform by the pipeline. **Have a look but please don't change it unless you know what you are doing.**                                 |

Now create a directory called `deployment\terraform` in the product's main repository and copy above files into it (
The `readme.md` file is of cause not required).

Afterwards, please open the `main.tf` file in a suitable text editor (VS Code has a Terraform plugin that helps in
formatting).

### Updating the meta information

Looking at the file you will see the following content:

```terraform
module "meta" {
  source              = "git::https://dev.azure.com/dathaynha/DatHa%20Platform/_git/terraform-components//modules/meta_configuration"
  application_name    = "Sample Application"
  cost_center         = "sample"
  resource_group_name = var.resource_group_name
  resource_owner      = "platform-owner@example.com"
  prefix              = var.prefix
}
```

This Terraform code initiates a module called `meta`, whose source code is obtained from the platform Git repo and specifies
the basic information used for correctly naming and
the tagging the infrastructure blocks we will soon be adding. The respective entries should be changed to match to your
product's information.

| Entry               |   Change needed    | Description                                                                                                                                                                     |
| ------------------- | :----------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| source              |  :no_entry_sign:   | Location of the source code of the module                                                                                                                                       |
| application_name    | :white_check_mark: | The full name of the application that will be used to tag all the resources in Azure Portal.                                                                                    |
| cost_center         | :white_check_mark: | The short name of this application used for cost tracking reasons.                                                                                                              |
| resource_group_name |  :no_entry_sign:   | Specifies the Azure resource group, where the resources are created. Please son not change as this is injected by the build pipeline.                                           |
| resource_owner      | :white_check_mark: | The name or email address of the owner of the cloud resources (usually the PM of the product)                                                                                   |
| prefix              |  :no_entry_sign:   | Specifies a small prefix string added to all component names in order to distinguish them from other resources. This is also injected via the pipeline and need not be changed. |

### Adding required infrastructure components

After the necessary changes have been made, the actual infrastructure description needs to be added. As a general rule
infrastructure should only be described using the platform Terraform modules.
The list of available infrastructure modules can be
found [here](https://dev.azure.com/dathaynha/DatHa%20Platform/_git/terraform-components).

Let us assume our product needs a PostgreSql DB to store its master data. By looking at the list of available modules
we find the
[db_postgres](https://dev.azure.com/dathaynha/DatHa%20Platform/_git/terraform-components//modules/db_postgres)
module is available.
In order to specify the required DB we instantiate the module like shown below:

```terraform
module "masterDB" {
  source = "git::https://dev.azure.com/dathaynha/DatHa%20Platform/_git/terraform-components//modules/db_postgres"
  meta   = module.meta
  name   = "mst"
}
```

# Adding Services to Kubernetes

```
module "aks_deployment" {
  source                    = "git::https://dev.azure.com/dathaynha/DatHa%20Platform/_git/terraform-components//modules/k8s_deployment?ref=c2854282eab244ae4da4ce7f296b71d9d9715bf5"
  meta                      = null
  environment               = var.environment
  name                      = var.k8s_deployment_name
  aks_cluster_name          = var.aks_cluster_name
  kubernetes_namespace      = var.kubernetes_namespace
  resource_group_name       = var.resource_group_name
  type                      = var.type
  image_name                = var.image_name
  image_version             = var.image_version
  image_secrets_name        = var.image_secrets_name
  ports                     = var.ports
  request_cpu               = var.request_cpu
  request_memory            = var.request_memory
  read_only_root_filesystem = var.read_only_root_filesystem
}
```

# Overriding the defaults

# Obtaining credentials

After Terraform has created the infrastructure components, certain credentials are needed for making use of them (e.g.
connection strings to DBs).
The platform Terraform components store such credentials automatically in a specific key vault created automatically by the
meta component. When inspecting the key vault the respective keys can be extracted.
