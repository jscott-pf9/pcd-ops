packer {
  required_plugins {
    qemu = {
      version = "~> 1"
      source  = "github.com/hashicorp/qemu"
    }
  }
}

variable "github_repo" {
  description = "Git repository to clone (use SSH URL for private repos)"
  default     = "https://github.com/your-org/pcd-ops.git"
}

variable "output_dir" {
  default = "output"
}

# Ubuntu 22.04 LTS cloud image — boots via NoCloud seed in cd_files
source "qemu" "pcd-ops" {
  iso_url          = "https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img"
  iso_checksum     = "file:https://cloud-images.ubuntu.com/jammy/current/SHA256SUMS"
  disk_image       = true
  format           = "qcow2"
  output_directory = var.output_dir
  vm_name          = "pcd-ops.qcow2"

  disk_size = "20G"
  memory    = 4096
  cpus      = 2
  headless  = true

  # NoCloud datasource: injects SSH credentials for Packer during the build.
  # The ubuntu user password is locked at the end of provision.sh.
  cd_files = ["./cloud-init/meta-data", "./cloud-init/user-data"]
  cd_label = "cidata"

  boot_wait        = "15s"
  ssh_username     = "ubuntu"
  ssh_password     = "packer-build-temp"
  ssh_timeout      = "15m"
  shutdown_command = "sudo shutdown -P now"
}

build {
  sources = ["source.qemu.pcd-ops"]

  provisioner "shell" {
    environment_vars = ["GITHUB_REPO=${var.github_repo}"]
    # Run as root so apt-get, systemctl, useradd, etc. work without per-line sudo.
    # The script uses `sudo -u pcd-ops` where it needs to act as the service user.
    execute_command = "sudo bash -c '{{ .Vars }} {{ .Path }}'"
    script          = "scripts/provision.sh"
  }
}
