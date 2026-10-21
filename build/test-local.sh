#!/usr/bin/env bash
# Boot the built appliance the way Nova does: a qcow2 overlay plus an OpenStack config drive
# (ISO label config-2) carrying catalog-style user-data. Polls /api/health, then powers the VM
# off and reads the guest disk offline (no sshd) to report the cloud-init datasource and
# whether /etc/pcd-app/config.env was written.
#
#   build/test-local.sh [user-data-file]        (default: build/user-data.sample)
#
# Environment:
#   FIRMWARE=uefi|bios   uefi = q35 + OVMF (default), bios = SeaBIOS
#   IMAGE=<qcow2>        default: newest deploy/packer/alpine/output/*/pcd-ops-*.qcow2
#   PORT=8180            host port forwarded to guest :80
#   TIMEOUT=300          seconds to wait for /api/health
#   KEEP=1               leave the VM running (skips the offline disk checks)
#
# Needs: qemu-system-x86_64 (KVM), qemu-img, genisoimage, OVMF, sfdisk + debugfs (e2fsprogs).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

FIRMWARE=${FIRMWARE:-uefi}
USER_DATA=${1:-build/user-data.sample}
PORT=${PORT:-8180}
TIMEOUT=${TIMEOUT:-300}
RUN=${RUN:-build/run/$FIRMWARE}
IMAGE=${IMAGE:-$(ls -t deploy/packer/alpine/output/*/pcd-ops-*.qcow2 2>/dev/null | head -1)}
[ -f "${IMAGE:-}" ] || { echo "no image found; build first: deploy/build-image.sh" >&2; exit 1; }
echo "==> Image: $IMAGE  firmware: $FIRMWARE  user-data: $USER_DATA"

rm -rf "$RUN" && mkdir -p "$RUN/cd/openstack/latest"
qemu-img create -q -f qcow2 -b "$(realpath "$IMAGE")" -F qcow2 "$RUN/disk.qcow2"
cp "$USER_DATA" "$RUN/cd/openstack/latest/user_data"
echo '{"uuid": "00000000-0000-4000-8000-000000000002", "hostname": "pcd-ops-test", "name": "pcd-ops-test"}' \
  > "$RUN/cd/openstack/latest/meta_data.json"
genisoimage -quiet -o "$RUN/config-drive.iso" -V config-2 -r -J "$RUN/cd"

case "$FIRMWARE" in
  uefi)
    # Same shape as PCD with hw_firmware_type=uefi, hw_machine_type=q35, secure boot off.
    OVMF=${OVMF:-/usr/share/OVMF}
    cp "$OVMF/OVMF_VARS_4M.fd" "$RUN/vars.fd"
    FW_ARGS=(-machine q35
      -drive "if=pflash,format=raw,readonly=on,file=$OVMF/OVMF_CODE_4M.fd"
      -drive "if=pflash,format=raw,file=$RUN/vars.fd")
    ;;
  bios) FW_ARGS=() ;;   # PCD's default: i440fx + SeaBIOS
  *) echo "FIRMWARE must be uefi or bios" >&2; exit 1 ;;
esac

echo "==> Booting (console: $RUN/console.log, http://127.0.0.1:$PORT/)"
qemu-system-x86_64 -enable-kvm "${FW_ARGS[@]}" -m 4096 -smp 2 -display none \
  -daemonize -pidfile "$RUN/qemu.pid" \
  -drive file="$RUN/disk.qcow2",if=virtio \
  -drive file="$RUN/config-drive.iso",if=virtio,format=raw,readonly=on \
  -netdev user,id=n0,hostfwd=tcp:127.0.0.1:$PORT-:80 -device virtio-net-pci,netdev=n0 \
  -serial file:"$RUN/console.log" -monitor unix:"$RUN/monitor.sock",server,nowait
stop_vm() { kill "$(cat "$RUN/qemu.pid" 2>/dev/null)" 2>/dev/null || true; }
# ACPI power button, so the guest unmounts cleanly before the disk is read; kill after 60s.
powerdown_vm() {
  python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.sendall(b"system_powerdown\n")' \
    "$RUN/monitor.sock" 2>/dev/null || true
  for _ in $(seq 60); do kill -0 "$(cat "$RUN/qemu.pid")" 2>/dev/null || return 0; sleep 1; done
  echo "    (guest ignored ACPI powerdown; killing)"; stop_vm; sleep 1
}
trap '[ -n "${KEEP:-}" ] || stop_vm' EXIT

healthy=
start=$(date +%s)
until curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health"; do
  if [ $(( $(date +%s) - start )) -ge "$TIMEOUT" ]; then break; fi
  sleep 2
done
elapsed=$(( $(date +%s) - start ))
if curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
  healthy=1
  echo "==> /api/health: 200 after ${elapsed}s: $(curl -s "http://127.0.0.1:$PORT/api/health")"
  # Everything else needs a PCD login (APPLIANCE_STANDARD §7); the connection comes from config.env.
  echo "==> /api/auth/session: $(curl -s "http://127.0.0.1:$PORT/api/auth/session")"
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/settings")
  echo "==> /api/settings without a login: HTTP $code (expect 401)"
  [ "$code" = 401 ] || healthy=
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/login")
  echo "==> /login (SPA): HTTP $code"
else
  echo "==> /api/health: no answer after ${elapsed}s (HTTP $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health"))"
fi

if [ -n "${KEEP:-}" ]; then echo "KEEP set: VM left running (pid $(cat "$RUN/qemu.pid"))"; exit 0; fi

# Power off and read the guest root filesystem offline with debugfs (no root needed).
powerdown_vm
qemu-img convert -O raw "$RUN/disk.qcow2" "$RUN/disk.raw"
offset=$(/sbin/sfdisk -J "$RUN/disk.raw" | python3 -c '
import json, sys
parts = json.load(sys.stdin)["partitiontable"]["partitions"]
root = max(parts, key=lambda p: p["size"])
print(root["start"] * 512)')
# -c: tolerate stale bitmaps if the guest had to be killed.
guest_cat() { /sbin/debugfs -c -R "cat $1" "$RUN/disk.raw?offset=$offset" 2>/dev/null; }

echo "==> cloud-init datasource:"
grep -E 'DataSource|datasource found' "$RUN/console.log" | sort -u | sed 's/^/    console: /' || true
guest_cat /var/log/cloud-init.log | grep -E 'Detected platform|Used Datasource|finished at' | tail -3 | sed 's/^/    cloud-init.log: /' || true
echo "==> /etc/pcd-app/config.env in guest:"
if guest_cat /etc/pcd-app/config.env | grep -q .; then
  guest_cat /etc/pcd-app/config.env | sed 's/^/    /'
else
  echo "    (missing)"
fi
rm -f "$RUN/disk.raw"
[ -n "$healthy" ]
