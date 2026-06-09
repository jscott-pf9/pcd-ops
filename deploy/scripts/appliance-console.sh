#!/bin/sh
# PCD Ops Appliance Console
# Runs on tty1 as the getty replacement (configured in /etc/inittab).
# This is the primary management interface — the appliance does not run sshd.
# Runs as root under init; no sudo needed for system operations.

export TERM=linux
APP_DIR="/opt/pcd-ops"

# ── ANSI colors ───────────────────────────────────────────────────────────────
G='\033[0;32m'   # green
R='\033[0;31m'   # red
Y='\033[0;33m'   # yellow
W='\033[1;37m'   # bold white
D='\033[2m'      # dim
N='\033[0m'      # reset
CLS='\033[2J\033[H'

# ── Helpers ───────────────────────────────────────────────────────────────────

get_ip() {
  ip -4 addr show scope global 2>/dev/null \
    | awk '/inet /{print $2}' | cut -d/ -f1 | head -1
}

get_status() {
  if rc-service pcd-ops status >/dev/null 2>&1; then
    printf "${G}● Running${N}"
  else
    printf "${R}● Stopped${N}"
  fi
}

get_version() {
  git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown"
}

get_alpine_ver() {
  cat /etc/alpine-release 2>/dev/null || echo "unknown"
}

read_key() {
  stty -echo -icanon min 1 time 0 2>/dev/null
  KEY=$(dd if=/dev/tty bs=1 count=1 2>/dev/null)
  stty echo icanon 2>/dev/null
  # Arrow/function keys send ESC sequences (e.g. \033[B for down arrow).
  # Reading 1 byte at a time means the trailing B would match [B]oot next loop.
  # Detect ESC and drain the rest of the sequence so it becomes a no-op.
  KEYCODE=$(printf '%s' "$KEY" | od -An -tx1 | tr -d ' \n')
  if [ "$KEYCODE" = "1b" ]; then
    stty -echo -icanon min 0 time 1 2>/dev/null
    dd if=/dev/tty bs=8 count=1 2>/dev/null >/dev/null
    stty echo icanon 2>/dev/null
    KEY=""
  fi
  printf '%s' "$KEY" | tr '[:upper:]' '[:lower:]'
}

press_any_key() {
  printf "\n  ${D}Press any key to return to menu...${N}"
  read_key >/dev/null
}

# ── Main menu ─────────────────────────────────────────────────────────────────

draw_main() {
  IP=$(get_ip)
  VER=$(get_version)
  ALPINE=$(get_alpine_ver)

  printf "${CLS}"
  printf "\n"
  printf "  ${W}PCD Ops${N} ${D}— Platform9 Operations Dashboard${N}\n"
  printf "  ${D}Alpine Linux v${ALPINE} | Build: ${VER}${N}\n"
  printf "\n"
  printf "  System Status:    $(get_status)\n"
  printf "  IP Address:       ${W}${IP:-not assigned}${N}\n"
  printf "  Web Interface:    ${W}http://${IP:-<ip-not-assigned>}/${N}\n"
  printf "\n"
  printf "  ${D}──────────────────────────────────────────────────${N}\n"
  printf "\n"
  printf "  ${W}+────────────────────────────────────────────────+${N}\n"
  printf "  ${W}│${N}            APPLIANCE MAIN MENU               ${W}│${N}\n"
  printf "  ${W}+────────────────────────────────────────────────+${N}\n"
  printf "  ${W}│${N}  ${Y}[R]${N}  Restart app                            ${W}│${N}\n"
  printf "  ${W}│${N}  ${Y}[B]${N}  Reboot appliance                       ${W}│${N}\n"
  printf "  ${W}│${N}  ${Y}[S]${N}  Shutdown                               ${W}│${N}\n"
  printf "  ${W}│${N}  ${Y}[A]${N}  Advanced options                       ${W}│${N}\n"
  printf "  ${W}+────────────────────────────────────────────────+${N}\n"
  printf "\n"
  printf "  Press a key to select an option...\n"
}

# ── Advanced menu ─────────────────────────────────────────────────────────────

draw_advanced() {
  IP=$(get_ip)
  VER=$(get_version)

  printf "${CLS}"
  printf "\n"
  printf "  ${W}PCD Ops${N} ${D}Advanced Options${N} ${D}| Build: ${VER}${N}\n"
  printf "\n"
  printf "  ${W}+────────────────────────────────────────────────+${N}\n"
  printf "  ${W}│${N}            ADVANCED OPTIONS                   ${W}│${N}\n"
  printf "  ${W}+────────────────────────────────────────────────+${N}\n"
  printf "  ${W}│${N}  ${Y}[U]${N}  Force app update (git pull + rebuild)  ${W}│${N}\n"
  printf "  ${W}│${N}  ${Y}[L]${N}  View app logs                          ${W}│${N}\n"
  printf "  ${W}│${N}  ${Y}[N]${N}  Network info                           ${W}│${N}\n"
  printf "  ${W}│${N}  ${Y}[X]${N}  Emergency shell                        ${W}│${N}\n"
  printf "  ${W}│${N}  ${Y}[B]${N}  Back to main menu                      ${W}│${N}\n"
  printf "  ${W}+────────────────────────────────────────────────+${N}\n"
  printf "\n"
  printf "  Press a key to select an option...\n"
}

# ── Advanced actions ──────────────────────────────────────────────────────────

do_force_update() {
  printf "${CLS}"
  printf "\n  ${W}Force App Update${N}\n"
  printf "  ${D}Running: git pull + pip install + npm build + restart${N}\n"
  printf "  ${D}──────────────────────────────────────────────────────${N}\n\n"

  # Run update.sh as the pcd-ops user (same as normal update flow)
  # The script handles the service restart at the end.
  if su -s /bin/sh pcd-ops -c "PCD_OPS_DIR=$APP_DIR $APP_DIR/deploy/scripts/update.sh"; then
    printf "\n  ${G}Update completed successfully.${N}\n"
  else
    printf "\n  ${R}Update failed — check output above for errors.${N}\n"
  fi

  press_any_key
}

do_view_logs() {
  printf "${CLS}"
  printf "\n  ${W}App Logs${N} ${D}— /var/log/pcd-ops/uvicorn.log${N}\n"
  printf "  ${D}Last 100 lines. Press q to exit, then any key to return to menu.${N}\n"
  printf "  ${D}──────────────────────────────────────────────────────${N}\n\n"

  if [ -f /var/log/pcd-ops/uvicorn.log ]; then
    tail -n 100 /var/log/pcd-ops/uvicorn.log | less
    press_any_key
  else
    printf "  ${Y}Log file not found — service may not have run yet.${N}\n"
    press_any_key
  fi
}

do_network_info() {
  printf "${CLS}"
  printf "\n  ${W}Network Information${N}\n"
  printf "  ${D}──────────────────────────────────────────────────────${N}\n\n"
  ip -4 addr show 2>/dev/null
  printf "\n"
  ip route show 2>/dev/null
  press_any_key
}

do_emergency_shell() {
  printf "${CLS}"
  printf "\n  ${W}Emergency Shell${N}\n"
  printf "\n"
  printf "  ${Y}Warning:${N} This drops to a root shell.\n"
  IP=$(get_ip)
  printf "  Use the web interface at ${W}http://${IP:-<ip>}/${N} for configuration.\n"
  printf "  Type ${D}exit${N} when done to return to the appliance menu.\n\n"
  /bin/sh
}

# ── Advanced loop ─────────────────────────────────────────────────────────────

advanced_menu() {
  while true; do
    draw_advanced
    KEY=$(read_key)
    case "$KEY" in
      u) do_force_update ;;
      l) do_view_logs ;;
      n) do_network_info ;;
      x) do_emergency_shell ;;
      b) return ;;
    esac
  done
}

# ── Main loop ─────────────────────────────────────────────────────────────────

while true; do
  draw_main
  KEY=$(read_key)

  case "$KEY" in
    r)
      printf "\n  ${Y}Restarting pcd-ops…${N}\n"
      rc-service pcd-ops restart
      sleep 2
      ;;

    b)
      printf "\n  ${R}Rebooting in 3 seconds — press Ctrl+C to cancel.${N}\n"
      sleep 3 && reboot
      ;;

    s)
      printf "\n  ${R}Shutting down in 3 seconds — press Ctrl+C to cancel.${N}\n"
      sleep 3 && poweroff
      ;;

    a)
      advanced_menu
      ;;

    *)
      # Any other key refreshes the display
      ;;
  esac
done
