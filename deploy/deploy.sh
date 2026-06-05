#!/usr/bin/env bash
# Simple OpenStack CLI wrapper to deploy a pcd-ops VM from the pre-built image.
# Prefer deploy/terraform/ for production; this is a quick alternative.
#
# Prerequisites: openstack CLI + OS_* env vars set (or sourced from .env).
# The pcd-ops Glance image must already be uploaded — see deploy/build-image.sh.
set -euo pipefail

IMAGE_NAME="${PCD_OPS_IMAGE:-pcd-ops}"
FLAVOR="${PCD_OPS_FLAVOR:-m1.medium}"
NETWORK="${PCD_OPS_NETWORK:-locallan}"
KEY_NAME="${PCD_OPS_KEY_NAME:-default}"
SECURITY_GROUP="${PCD_OPS_SECURITY_GROUP:-default}"
VM_NAME="pcd-ops"

echo "Creating VM: $VM_NAME  (image: $IMAGE_NAME)"
SERVER_ID=$(openstack server create \
  --image "$IMAGE_NAME" \
  --flavor "$FLAVOR" \
  --network "$NETWORK" \
  --key-name "$KEY_NAME" \
  --security-group "$SECURITY_GROUP" \
  --user-data "$(dirname "$0")/cloud-init.yaml" \
  --format value --column id \
  "$VM_NAME")

echo "Server ID: $SERVER_ID"
echo "Waiting for ACTIVE status..."
openstack server wait --timeout 300 "$SERVER_ID"

IP=$(openstack server show "$SERVER_ID" --format value --column addresses \
  | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)
echo ""
echo "VM is ACTIVE.  IP: $IP"
echo "App:  http://$IP"
echo "SSH:  ssh ubuntu@$IP"
echo ""
echo "Open the app, go to Settings, and enter your OpenStack / Grafana credentials."
