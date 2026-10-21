#!/usr/bin/env bash
# Build the pcd-ops appliance qcow2 image using Packer + QEMU (Alpine Linux).
# Output, in deploy/packer/alpine/output/<tag>/ — the PCD App Catalog's release format
# (the tag keeps its "v", the file names don't):
#   pcd-ops-<version>.qcow2          the image
#   pcd-ops-<version>.qcow2.sha256   sha256sum format
#   manifest.json                    repo manifest.json with version/tag/asset/checksum filled in
# The image must pass Nova's format-inspector safety check or the build fails.
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

# UEFI pflash unit=1 must be writable — copy system VARS to a local file Packer can modify.
# Cleaned up after the build regardless of success/failure.
OVMF_VARS_TMP="$PACKER_DIR/ovmf-vars-tmp.fd"
cp /usr/share/OVMF/OVMF_VARS_4M.fd "$OVMF_VARS_TMP"
trap "rm -f '$OVMF_VARS_TMP'" EXIT

echo "Building pcd-ops-${VERSION}.qcow2 ..."
# -force overwrites any existing output directory for this version
packer build -force -var "version=${VERSION}" -var "github_branch=${BRANCH}" "$@" pcd-ops-alpine.pkr.hcl

OUT_DIR="$PACKER_DIR/output/${VERSION}"
REL_VERSION="${VERSION#v}"
ASSET="pcd-ops-${REL_VERSION}.qcow2"
OUTPUT="$OUT_DIR/$ASSET"
IMAGE_NAME="pcd-ops-${REL_VERSION}"

# Nova's format inspector (oslo_utils) rejects qcow2 images that have MBR boot
# signatures in unexpected positions. Re-encode as a clean qcow2 to avoid this.
echo "Re-encoding qcow2 to strip MBR safety-check trigger..."
qemu-img convert -f qcow2 -O qcow2 "$OUT_DIR/pcd-ops-${VERSION}.qcow2" "$OUTPUT.tmp"
rm -f "$OUT_DIR/pcd-ops-${VERSION}.qcow2"
mv "$OUTPUT.tmp" "$OUTPUT"

# Same check Nova runs on the raw disk before booting it. oslo.utils lives in a
# scratch venv next to this script's Packer dir (gitignored).
echo "Running Nova format-inspector safety check..."
INSPECT_VENV="$PACKER_DIR/.venv"
if [ ! -x "$INSPECT_VENV/bin/python" ]; then
  python3 -m venv "$INSPECT_VENV"
  "$INSPECT_VENV/bin/pip" install -q oslo.utils cryptography
fi
RAW="$OUT_DIR/safety-check.raw"
qemu-img convert -O raw "$OUTPUT" "$RAW"
if ! "$INSPECT_VENV/bin/python" -I -c '
import sys
from oslo_utils.imageutils import format_inspector
fmt = format_inspector.detect_file_format(sys.argv[1])
fmt.safety_check()
print(f"  {fmt}: safety check passed")' "$RAW"; then
  rm -f "$RAW"
  echo "ERROR: $OUTPUT fails Nova's safety check" >&2
  exit 1
fi
rm -f "$RAW"

echo "Writing checksum and release manifest..."
(cd "$OUT_DIR" && sha256sum "$ASSET" > "$ASSET.sha256")
SHA256=$(cut -d' ' -f1 "$OUT_DIR/$ASSET.sha256")
python3 - "$SCRIPT_DIR/../manifest.json" "$OUT_DIR/manifest.json" "$REL_VERSION" "$VERSION" "$ASSET" "$SHA256" <<'PY'
import json, sys
src, dst, version, tag, asset, sha = sys.argv[1:]
m = json.load(open(src))
m["version"] = version
m["image"]["source"].update(tag=tag, asset=asset, checksum=f"sha256:{sha}")
with open(dst, "w") as f:
    json.dump(m, f, indent=2)
    f.write("\n")
PY

echo ""
echo "Image built: $OUTPUT"
echo "Release assets in $OUT_DIR: $ASSET, $ASSET.sha256, manifest.json"
echo "Boot test:  build/test-local.sh   (FIRMWARE=bios for SeaBIOS)"
echo "Publish:    deploy/release.sh     (HEAD at a pushed v<version> tag)"
echo ""
# The image is hybrid BIOS+UEFI (bios_grub + ESP), so no hw_firmware_type
# property is needed — it boots under SeaBIOS or OVMF.
echo "Upload to PCD:"
echo "  pcdctl image create --insecure \\"
echo "    --container-format bare --disk-format qcow2 \\"
echo "    --property os_type=Linux \\"
echo "    --public \\"
echo "    --file $OUTPUT ${IMAGE_NAME}"
