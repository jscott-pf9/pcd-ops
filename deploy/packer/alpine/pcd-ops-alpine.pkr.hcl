# Alpine 3.21 BIOS + cloud-init build for pcd-ops.
# Packer 1.6.x — QEMU builder is built-in, no required_plugins block needed.

variable "github_repo" {
  description = "Git repository to clone (use SSH URL for private repos)"
  default     = "https://github.com/jscott-pf9/pcd-ops.git"
}

variable "output_dir" {
  default = "output"
}

# Alpine 3.21.7 nocloud BIOS cloud-init image
source "qemu" "pcd-ops-alpine" {
  iso_url      = "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/cloud/nocloud_alpine-3.21.7-x86_64-bios-cloudinit-r0.qcow2"
  iso_checksum = "sha512:5b22a46e9aa6bbacf585c055e87362c8be1993e53c121bdaf74203ac3490c70bdbbf714df4276eef36184ea8c11fd7cd3b28c9ccc74f6a9a82c430d441fa2f95"
  disk_image   = true
  format       = "qcow2"

  output_directory = var.output_dir
  vm_name          = "pcd-ops-alpine.qcow2"

  disk_size = "20G"
  memory    = 4096
  cpus      = 2
  headless  = true

  # NoCloud datasource — provides SSH credentials for Packer during build.
  # The alpine user password is locked at the end of provision-alpine.sh.
  cd_files = ["./cloud-init/meta-data", "./cloud-init/user-data"]
  cd_label = "cidata"

  boot_wait        = "60s"
  ssh_username     = "alpine"
  ssh_password     = "packer-build-temp"
  ssh_timeout      = "20m"
  shutdown_command = "sudo poweroff"
}

build {
  sources = ["source.qemu.pcd-ops-alpine"]

  provisioner "shell" {
    environment_vars = ["GITHUB_REPO=${var.github_repo}"]
    # Run as root so apk, rc-update, adduser, etc. work without per-line sudo.
    # The script uses `su -s /bin/sh pcd-ops -c` where it needs the service user.
    execute_command = "sudo sh -c '{{ .Vars }} {{ .Path }}'"
    script          = "scripts/provision-alpine.sh"
  }
}
