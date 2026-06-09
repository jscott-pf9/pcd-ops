#!/bin/sh
# PCD Ops Appliance Console
# Runs on tty1 as the getty replacement (configured in /etc/inittab).
# Provides a minimal appliance-style TUI — status, URL, and basic controls.
# Runs as root under init; no sudo needed for reboot/restart.

export TERM=linux

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
  git -C /opt/pcd-ops rev-parse --short HEAD 2>/dev/null || echo "unknown"
}

get_alpine_ver() {
  cat /etc/alpine-release 2>/dev/null || echo "unknown"
}

read_key() {
  stty -echo -icanon min 1 time 0 2>/dev/null
  KEY=$(dd if=/dev/tty bs=1 count=1 2>/dev/null)
  stty echo icanon 2>/dev/null
  # Normalise to lowercase
  printf '%s' "$KEY" | tr '[:upper:]' '[:lower:]'
}

# ── Draw the appliance UI ─────────────────────────────────────────────────────

draw() {
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
  printf "  ${W}│${N}  ${Y}[L]${N}  Login shell                            ${W}│${N}\n"
  printf "  ${W}│${N}  ${Y}[R]${N}  Restart app                            ${W}│${N}\n"
  printf "  ${W}│${N}  ${Y}[B]${N}  Reboot appliance                       ${W}│${N}\n"
  printf "  ${W}│${N}  ${Y}[S]${N}  Shutdown                               ${W}│${N}\n"
  printf "  ${W}+────────────────────────────────────────────────+${N}\n"
  printf "\n"
  printf "  Press a key to select an option...\n"
}

# ── Main loop ─────────────────────────────────────────────────────────────────

while true; do
  draw

  KEY=$(read_key)

  case "$KEY" in
    l)
      printf "\033[2J\033[H"
      printf "\n  ${W}Login shell${N} — type ${D}exit${N} to return to the appliance menu.\n\n"
      /bin/login
      ;;

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

    *)
      # Any other key refreshes the display
      ;;
  esac
done
