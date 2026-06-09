variable "os_auth_url" {
  description = "OpenStack Keystone endpoint"
  type        = string
}

variable "os_username" {
  description = "OpenStack username"
  type        = string
}

variable "os_password" {
  description = "OpenStack password"
  type        = string
  sensitive   = true
}

variable "os_project_name" {
  description = "OpenStack project/tenant"
  type        = string
}

variable "os_user_domain_name" {
  description = "OpenStack user domain"
  type        = string
  default     = "Default"
}

variable "os_project_domain_name" {
  description = "OpenStack project domain"
  type        = string
  default     = "Default"
}

variable "os_region_name" {
  description = "OpenStack region"
  type        = string
  default     = "RegionOne"
}

variable "vm_name" {
  description = "Name for the pcd-ops VM"
  type        = string
  default     = "pcd-ops"
}

variable "image_name" {
  description = "Glance image name — upload the pcd-ops qcow2 built by deploy/build-image.sh"
  type        = string
  default     = "pcd-ops"
}

variable "flavor_name" {
  description = "Nova flavor"
  type        = string
  default     = "m1.medium"
}

variable "network_name" {
  description = "Neutron network to attach to"
  type        = string
  default     = "locallan"
}


