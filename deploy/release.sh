#!/usr/bin/env bash
# Release PCD Ops in the PCD App Catalog's format (APPLIANCE_STANDARD §2, §4). Stops on the
# first failure:
#   1. Build the image from the tag at HEAD (deploy/build-image.sh: Nova safety check,
#      pcd-ops-<version>.qcow2 + .sha256, manifest.json with version and checksum filled in)
#   2. Boot it the way Nova does, under UEFI and BIOS (build/test-local.sh)
#   3. Check the assets agree, and validate the manifest with the catalog's validator
#   4. Create the GitHub release with the three assets
#   5. Check they download anonymously (Glance imports them without credentials)
#   6. Open a PR adding the manifest to the extension index (jscott-pf9/pcd-extensions)
#
# Usage:
#   git tag v0.5.0 && git push origin main v0.5.0
#   ./deploy/release.sh --preflight             # steps 1-3 only; publishes nothing
#   ./deploy/release.sh [--skip-build] [notes.md]
#
# Environment: CATALOG_DIR (default ../pcd-app-catalog) for the manifest validator.
set -euo pipefail

REPO=jscott-pf9/pcd-ops
INDEX_REPO=jscott-pf9/pcd-extensions
APP_ID=pcd-ops
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
CATALOG_DIR=${CATALOG_DIR:-$ROOT/../pcd-app-catalog}

PREFLIGHT= SKIP_BUILD= NOTES=
for arg in "$@"; do
  case "$arg" in
    --preflight)  PREFLIGHT=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -*) echo "unknown option $arg" >&2; exit 1 ;;
    *) NOTES=$arg ;;
  esac
done

step() { echo; echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

TAG=$(git -C "$ROOT" describe --tags --exact-match 2>/dev/null) \
  || die "HEAD is not at a tag; tag it v<version> first"
VERSION=${TAG#v}
DIR="$SCRIPT_DIR/packer/alpine/output/$TAG"
ASSET="pcd-ops-$VERSION.qcow2"
git -C "$ROOT" ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null \
  || die "tag $TAG is not on origin (Packer clones from GitHub); git push origin $TAG"
grep -q "^version = \"$VERSION\"" "$ROOT/backend/pyproject.toml" \
  || die "backend/pyproject.toml is not at version $VERSION"

step "1/6 Build $TAG"
if [ -n "$SKIP_BUILD" ] && [ -f "$DIR/$ASSET" ]; then
  echo "using the existing build in $DIR"
else
  "$SCRIPT_DIR/build-image.sh"
fi
for f in "$ASSET" "$ASSET.sha256" manifest.json; do
  [ -f "$DIR/$f" ] || die "missing $DIR/$f"
done

step "2/6 Boot test (UEFI and BIOS)"
FIRMWARE=uefi PORT=8180 IMAGE="$DIR/$ASSET" "$ROOT/build/test-local.sh"
FIRMWARE=bios PORT=8181 IMAGE="$DIR/$ASSET" "$ROOT/build/test-local.sh"

step "3/6 Check the assets and validate the manifest"
(cd "$DIR" && sha256sum -c --quiet "$ASSET.sha256")
python3 - "$DIR/manifest.json" "$TAG" "$VERSION" "$ASSET" "$(cut -d' ' -f1 "$DIR/$ASSET.sha256")" <<'PY'
import json, sys
path, tag, version, asset, sha = sys.argv[1:]
m = json.load(open(path))
src = m["image"]["source"]
assert m["version"] == version, f"manifest version {m['version']} != {version}"
assert (src["tag"], src["asset"], src["checksum"]) == (tag, asset, f"sha256:{sha}"), src
PY
[ -x "$CATALOG_DIR/.venv/bin/python" ] || die "manifest validator not found; set CATALOG_DIR"
(cd "$CATALOG_DIR" && .venv/bin/python -c \
  "import json,sys; from backend.manifests import validate_manifest; e=validate_manifest(json.load(open(sys.argv[1])))[1]; print('\n'.join(e) or 'valid'); sys.exit(bool(e))" \
  "$DIR/manifest.json")

if [ -n "$PREFLIGHT" ]; then
  echo; echo "Preflight passed for $TAG. Nothing was published."
  exit 0
fi

step "4/6 Create release $TAG on $REPO"
if [ -n "$NOTES" ]; then NOTES_ARGS=(--notes-file "$NOTES"); else NOTES_ARGS=(--generate-notes); fi
gh release create "$TAG" -R "$REPO" --title "PCD Ops $TAG" "${NOTES_ARGS[@]}" \
  "$DIR/$ASSET" "$DIR/$ASSET.sha256" "$DIR/manifest.json"

step "5/6 Check anonymous downloads"
BASE="https://github.com/$REPO/releases/download/$TAG"
curl -fsIL -o /dev/null "$BASE/$ASSET" || die "$ASSET is not downloadable anonymously"
curl -fsSL "$BASE/manifest.json" | cmp -s - "$DIR/manifest.json" \
  || die "manifest.json download does not match"
curl -fsSL "$BASE/$ASSET.sha256" | cmp -s - "$DIR/$ASSET.sha256" \
  || die "$ASSET.sha256 download does not match"
got=$(curl -fsSL "$BASE/$ASSET" | sha256sum | cut -d' ' -f1)
[ "$got" = "$(cut -d' ' -f1 "$DIR/$ASSET.sha256")" ] || die "$ASSET download checksum mismatch: $got"
echo "OK: $BASE/{$ASSET,$ASSET.sha256,manifest.json}"

step "6/6 Submit to the extension index ($INDEX_REPO)"
# APPLIANCE_STANDARD §4. Needs gh with push access to the index repo.
submit_to_index() {   # $1 = absolute path to the released manifest.json, $2 = version; needs APP_ID
  local work; work=$(mktemp -d)
  gh repo clone "$INDEX_REPO" "$work/idx" -- -q
  python3 -m venv "$work/venv" && "$work/venv/bin/pip" -q install jsonschema==4.23.0
  ( cd "$work/idx"
    git switch -c "release/$APP_ID-$2"
    "$work/venv/bin/python" tools/add_release.py "$1" --published "$(date -u +%F)"
    "$work/venv/bin/python" tools/validate.py --base origin/main
    git add -A && git commit -qm "$APP_ID $2"
    git push -q -u origin HEAD
    gh pr create --fill )
}
submit_to_index "$DIR/manifest.json" "$VERSION"

echo
echo "Released $TAG. Once the index PR is merged, PCD's catalog offers it."
echo "Then copy $DIR/manifest.json over the repo's manifest.json and commit."
