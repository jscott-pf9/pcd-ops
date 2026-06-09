#!/usr/bin/env bash
# Build the Alpine-based pcd-ops qcow2 image using Packer + QEMU.
# Output: deploy/packer/alpine/output/pcd-ops-alpine.qcow2
#
# Prerequisites:
#   apt install qemu-system-x86 qemu-utils   (or equivalent)
#   packer (>= 1.6, QEMU builder is built-in)
#
# Usage:
#   ./deploy/build-image-alpine.sh
#   ./deploy/build-image-alpine.sh -var github_repo=git@github.com:jscott-pf9/pcd-ops.git
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKER_DIR="$SCRIPT_DIR/packer/alpine"

cd "$PACKER_DIR"

echo "Building pcd-ops-alpine.qcow2 ..."
packer build "$@" pcd-ops-alpine.pkr.hcl

OUTPUT="$PACKER_DIR/output/pcd-ops-alpine.qcow2"
echo ""
echo "Image built: $OUTPUT"
echo ""
echo "Upload to Glance:"
echo "  openstack image create pcd-ops-alpine \\"
echo "    --disk-format qcow2 --container-format bare \\"
echo "    --file $OUTPUT"
