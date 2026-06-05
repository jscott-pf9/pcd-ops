#!/usr/bin/env bash
# Build the pcd-ops qcow2 image using Packer + QEMU.
# Output: deploy/packer/output/pcd-ops.qcow2
#
# Prerequisites:
#   apt install qemu-system-x86 qemu-utils   (or equivalent)
#   packer init deploy/packer/
#
# Usage:
#   ./deploy/build-image.sh
#   ./deploy/build-image.sh -var github_repo=git@github.com:your-org/pcd-ops.git
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKER_DIR="$SCRIPT_DIR/packer"

cd "$PACKER_DIR"

if [[ ! -d ".packer.d" ]] && ! packer plugins installed 2>/dev/null | grep -q qemu; then
  echo "Initialising Packer plugins..."
  packer init .
fi

echo "Building pcd-ops.qcow2 ..."
packer build "$@" pcd-ops.pkr.hcl

OUTPUT="$PACKER_DIR/output/pcd-ops.qcow2"
echo ""
echo "Image built: $OUTPUT"
echo ""
echo "Upload to Glance:"
echo "  openstack image create pcd-ops \\"
echo "    --disk-format qcow2 --container-format bare \\"
echo "    --file $OUTPUT"
