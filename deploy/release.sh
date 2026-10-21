#!/usr/bin/env bash
# Publish a GitHub release in the PCD App Catalog's format, from the assets
# deploy/build-image.sh wrote for the tag at HEAD, then check that they download
# anonymously (Glance imports them without credentials).
#
# Usage:
#   git tag v0.4.2 && git push origin main v0.4.2
#   ./deploy/build-image.sh
#   build/test-local.sh && FIRMWARE=bios build/test-local.sh
#   ./deploy/release.sh [release-notes.md]
set -euo pipefail

REPO=jscott-pf9/pcd-ops
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TAG=$(git -C "$SCRIPT_DIR" describe --tags --exact-match 2>/dev/null) \
  || { echo "HEAD is not at a tag; tag it v<version> first" >&2; exit 1; }
VERSION=${TAG#v}
DIR="$SCRIPT_DIR/packer/alpine/output/$TAG"
ASSET="pcd-ops-$VERSION.qcow2"
NOTES=${1:-}

for f in "$ASSET" "$ASSET.sha256" manifest.json; do
  [ -f "$DIR/$f" ] || { echo "missing $DIR/$f; run deploy/build-image.sh" >&2; exit 1; }
done
(cd "$DIR" && sha256sum -c --quiet "$ASSET.sha256")
python3 - "$DIR/manifest.json" "$TAG" "$VERSION" "$ASSET" "$(cut -d' ' -f1 "$DIR/$ASSET.sha256")" <<'PY'
import json, sys
path, tag, version, asset, sha = sys.argv[1:]
m = json.load(open(path))
src = m["image"]["source"]
assert m["version"] == version, f"manifest version {m['version']} != {version}"
assert (src["tag"], src["asset"], src["checksum"]) == (tag, asset, f"sha256:{sha}"), src
PY
git -C "$SCRIPT_DIR" ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null \
  || { echo "tag $TAG is not on origin; git push origin $TAG" >&2; exit 1; }

echo "==> Creating release $TAG on $REPO"
if [ -n "$NOTES" ]; then NOTES_ARGS=(--notes-file "$NOTES"); else NOTES_ARGS=(--generate-notes); fi
gh release create "$TAG" -R "$REPO" --title "PCD Ops $TAG" "${NOTES_ARGS[@]}" \
  "$DIR/$ASSET" "$DIR/$ASSET.sha256" "$DIR/manifest.json"

echo "==> Checking anonymous downloads"
BASE="https://github.com/$REPO/releases/download/$TAG"
curl -fsSL "$BASE/manifest.json" | cmp -s - "$DIR/manifest.json" \
  || { echo "manifest.json download does not match" >&2; exit 1; }
curl -fsSL "$BASE/$ASSET.sha256" | cmp -s - "$DIR/$ASSET.sha256" \
  || { echo "$ASSET.sha256 download does not match" >&2; exit 1; }
got=$(curl -fsSL "$BASE/$ASSET" | sha256sum | cut -d' ' -f1)
[ "$got" = "$(cut -d' ' -f1 "$DIR/$ASSET.sha256")" ] \
  || { echo "$ASSET download checksum mismatch: $got" >&2; exit 1; }
echo "==> OK: $BASE/{$ASSET,$ASSET.sha256,manifest.json}"
