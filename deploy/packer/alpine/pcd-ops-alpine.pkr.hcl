# Alpine 3.21 UEFI + cloud-init build for pcd-ops.
# Uses UEFI (GPT) instead of BIOS/MBR so the image passes oslo.utils
# GPTInspector safety checks on modern OpenStack (PCD 2024+).
# Packer 1.10+ — QEMU builder is built-in, no required_plugins block needed.

variable "github_repo" {
  description = "Git repository to clone (use SSH URL for private repos)"
  default     = "https://github.com/jscott-pf9/pcd-ops.git"
}

variable "github_branch" {
  description = "Git branch to clone"
  default     = "main"
}

variable "version" {
  description = "Release version string — injected by build-image.sh from git describe"
  default     = "dev"
}

variable "output_dir" {
  default = "output"
}

# Alpine 3.21.7 nocloud UEFI cloud-init image (GPT partition table, no syslinux MBR)
source "qemu" "pcd-ops-alpine" {
  iso_url      = "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/cloud/nocloud_alpine-3.21.7-x86_64-uefi-cloudinit-r0.qcow2"
  iso_checksum = "sha512:779afcc0bfdd4074ca620bb67c2f70f3d6cad4cdaf4fd91a9fd8a127feb159d9407be18cd8f778ed1adf950799cd93b2692d49ad7ee2221ed6a52d8e895d4c37"
  disk_image   = true
  format       = "qcow2"

  output_directory = "${var.output_dir}/${var.version}"
  vm_name          = "pcd-ops-${var.version}.qcow2"

  disk_size    = "20G"
  memory       = 4096
  cpus         = 2
  headless     = true
  machine_type = "q35"

  # UEFI firmware — CODE is read-only; VARS is a per-build writable copy.
  qemuargs = [
    ["-drive", "if=pflash,format=raw,unit=0,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd"],
    ["-drive", "if=pflash,format=raw,unit=1,file=${path.root}/ovmf-vars-tmp.fd"],
  ]

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

  # Copy a writable OVMF VARS file before the VM starts (pflash unit=1 must be writable).
  provisioner "shell-local" {
    inline = ["cp /usr/share/OVMF/OVMF_VARS_4M.fd ${path.root}/ovmf-vars-tmp.fd"]
  }

  provisioner "shell" {
    environment_vars = ["GITHUB_REPO=${var.github_repo}", "GITHUB_BRANCH=${var.github_branch}"]
    # Run as root so apk, rc-update, adduser, etc. work without per-line sudo.
    # The script uses `su -s /bin/sh pcd-ops -c` where it needs the service user.
    execute_command = "sudo sh -c '{{ .Vars }} {{ .Path }}'"
    script          = "scripts/provision-alpine.sh"
  }

  # Clean up the temporary VARS file after the build.
  post-processor "shell-local" {
    inline = ["rm -f ${path.root}/ovmf-vars-tmp.fd"]
  }
}
