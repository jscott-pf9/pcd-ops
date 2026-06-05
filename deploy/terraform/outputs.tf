output "vm_id" {
  description = "UUID of the pcd-ops instance"
  value       = openstack_compute_instance_v2.pcd_ops.id
}

output "vm_ip" {
  description = "Private IP address of the pcd-ops instance"
  value       = openstack_compute_instance_v2.pcd_ops.access_ip_v4
}

output "app_url" {
  description = "URL for the pcd-ops UI (once cloud-init completes)"
  value       = "http://${openstack_compute_instance_v2.pcd_ops.access_ip_v4}"
}

output "ssh_command" {
  description = "SSH command to reach the VM"
  value       = "ssh ubuntu@${openstack_compute_instance_v2.pcd_ops.access_ip_v4}"
}
