#!/usr/bin/env bash
# Build the pcd-ops appliance qcow2 image using Packer + QEMU (Alpine Linux).
# Output: deploy/packer/alpine/output/pcd-ops-alpine.qcow2
#
# Prerequisites:
#   apt install qemu-system-x86 qemu-utils   (or equivalent)
#   packer >= 1.6 (QEMU builder is built-in)
#
# Usage:
#   ./deploy/build-image.sh
#   ./deploy/build-image.sh -var github_repo=git@github.com:jscott-pf9/pcd-ops.git
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKER_DIR="$SCRIPT_DIR/packer/alpine"

# Derive version from git tag (e.g. v0.2.1); fall back to short commit if untagged
VERSION=$(git -C "$SCRIPT_DIR" describe --tags --exact-match 2>/dev/null \
          || git -C "$SCRIPT_DIR" describe --tags --always 2>/dev/null \
          || echo "dev")

# Pass the current branch so Packer clones the right code
BRANCH=$(git -C "$SCRIPT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

echo "Version: $VERSION  Branch: $BRANCH"

cd "$PACKER_DIR"

echo "Building pcd-ops-${VERSION}.qcow2 ..."
# -force overwrites any existing output directory for this version
packer build -force -var "version=${VERSION}" -var "github_branch=${BRANCH}" "$@" pcd-ops-alpine.pkr.hcl

OUTPUT="$PACKER_DIR/output/${VERSION}/pcd-ops-${VERSION}.qcow2"
IMAGE_NAME="pcd-ops-${VERSION}"

echo ""
echo "Image built: $OUTPUT"
echo ""
echo "Upload to PCD:"
echo "  pcdctl image create --insecure \\"
echo "    --container-format bare --disk-format qcow2 \\"
echo "    --property os_type=Linux --public \\"
echo "    --file $OUTPUT ${IMAGE_NAME}"
