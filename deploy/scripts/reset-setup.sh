#!/bin/sh
# Reset first-run setup (APPLIANCE_STANDARD §7.10), called from the console TUI as root.
# Forgets the background application credential and any PCD connection entered at setup,
# then restarts pcd-ops (which also logs everyone out). The next admin to log in is asked
# to authorize background access again.
#
# The credential still exists in PCD: delete it there (Identity › Application Credentials,
# as its owner), since this console has no PCD login to do it with.
set -u

# 0.5.0+ images keep state in /var/lib/pcd-ops; appliances upgraded from 0.4.x use backend/data.
for d in /var/lib/pcd-ops /opt/pcd-ops/backend/data; do
  f="$d/app_credential.json"
  if [ -f "$f" ]; then
    name=$(sed -n 's/.*"name": *"\([^"]*\)".*/\1/p' "$f" | head -1)
    owner=$(sed -n 's/.*"owner": *"\([^"]*\)".*/\1/p' "$f" | head -1)
    echo "Forgetting application credential ${name:-?} (owner ${owner:-?})."
    echo "Delete it in PCD as that user: Identity > Application Credentials."
  fi
  rm -f "$f" "$d/connection.json"
done
rc-service pcd-ops restart
