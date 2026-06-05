#!/usr/bin/env bash
# Wrapper: reads credentials from ../../.env and runs terraform apply.
# Usage: ./deploy.sh [terraform args]   e.g. ./deploy.sh -auto-approve
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../../.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: .env not found at $ENV_FILE" >&2
  exit 1
fi

# Export OpenStack vars from .env as TF_VAR_* so Terraform picks them up
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

export TF_VAR_os_auth_url="$OS_AUTH_URL"
export TF_VAR_os_username="$OS_USERNAME"
export TF_VAR_os_password="$OS_PASSWORD"
export TF_VAR_os_project_name="$OS_PROJECT_NAME"
export TF_VAR_os_user_domain_name="${OS_USER_DOMAIN_NAME:-Default}"
export TF_VAR_os_project_domain_name="${OS_PROJECT_DOMAIN_NAME:-Default}"
export TF_VAR_os_region_name="${OS_REGION_NAME:-RegionOne}"

cd "$SCRIPT_DIR"

if [[ ! -d ".terraform" ]]; then
  echo "Running terraform init..."
  terraform init
fi

terraform apply "$@"
