terraform {
  required_providers {
    openstack = {
      source  = "terraform-provider-openstack/openstack"
      version = "~> 3.0"
    }
  }
}

provider "openstack" {
  auth_url           = var.os_auth_url
  user_name          = var.os_username
  password           = var.os_password
  tenant_name        = var.os_project_name
  user_domain_name   = var.os_user_domain_name
  project_domain_name = var.os_project_domain_name
  region             = var.os_region_name
}

# ── Security group ────────────────────────────────────────────────────────────

resource "openstack_networking_secgroup_v2" "pcd_ops" {
  name        = "${var.vm_name}-sg"
  description = "Allow SSH and pcd-ops app ports"
}

resource "openstack_networking_secgroup_rule_v2" "ssh" {
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "tcp"
  port_range_min    = 22
  port_range_max    = 22
  remote_ip_prefix  = "0.0.0.0/0"
  security_group_id = openstack_networking_secgroup_v2.pcd_ops.id
}

resource "openstack_networking_secgroup_rule_v2" "http" {
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "tcp"
  port_range_min    = 80
  port_range_max    = 80
  remote_ip_prefix  = "0.0.0.0/0"
  security_group_id = openstack_networking_secgroup_v2.pcd_ops.id
}

# ── Data sources ──────────────────────────────────────────────────────────────

data "openstack_images_image_v2" "pcd_ops" {
  name        = var.image_name
  most_recent = true
}

data "openstack_compute_flavor_v2" "flavor" {
  name = var.flavor_name
}

# ── VM ────────────────────────────────────────────────────────────────────────

resource "openstack_compute_instance_v2" "pcd_ops" {
  name            = var.vm_name
  image_id        = data.openstack_images_image_v2.pcd_ops.id
  flavor_id       = data.openstack_compute_flavor_v2.flavor.id
  key_pair        = var.key_pair
  security_groups = [openstack_networking_secgroup_v2.pcd_ops.name]

  network {
    name = var.network_name
  }

  user_data = file("${path.module}/cloud-init.yaml")

  metadata = {
    app = "pcd-ops"
  }
}
