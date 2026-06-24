#!/bin/sh
# PCD Ops Appliance Console — gum edition
# Requires: gum (apk add gum)

export TERM="${TERM:-linux}"
APP_DIR="/opt/pcd-ops"

# ── ANSI palette (8-color safe, works on VGA TERM=linux) ─────────────────────
RST='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'
GRN='\033[92m'    # bright green
RED='\033[91m'    # bright red
BBLU='\033[94m'   # bright blue
WHT='\033[97m'    # bright white
YEL='\033[93m'    # bright yellow

# gum color indices (ANSI 0-15, safe for TERM=linux)
C_BLUE="4"
C_GREEN="10"
C_RED="9"
C_YELLOW="11"
C_DIM="8"
C_WHITE="15"

# ── Box geometry ──────────────────────────────────────────────────────────────
BOX_W=62      # total width including │ borders
BOX_INNER=60  # BOX_W - 2

# Generate horizontal rule once at startup (60 × ─)
HR=$(awk -v n="$BOX_INNER" 'BEGIN{ for(i=0;i<n;i++) printf "─"; }')

# ── Helpers ───────────────────────────────────────────────────────────────────

get_ip() {
  ip -4 addr show scope global 2>/dev/null \
    | awk '/inet /{print $2}' | cut -d/ -f1 | head -1
}

is_running() {
  rc-service pcd-ops status >/dev/null 2>&1
}

get_version() {
  cat "$APP_DIR/version" 2>/dev/null \
    || git -C "$APP_DIR" describe --tags --always 2>/dev/null \
    || echo "unknown"
}

get_alpine_ver() {
  cat /etc/alpine-release 2>/dev/null | cut -d. -f1-2 || echo "?"
}

term_cols() {
  tput cols 2>/dev/null || echo 80
}

# Left pad to center the box on screen
box_pad() {
  local COLS=$(term_cols)
  local P=$(( (COLS - BOX_W) / 2 ))
  [ "$P" -lt 0 ] && P=0
  echo "$P"
}

# Character count (handles UTF-8 multibyte for centering calc)
char_len() {
  printf '%s' "$1" | wc -m
}

# ── Box drawing primitives ────────────────────────────────────────────────────

box_top() { printf "%*s${DIM}┌${HR}┐${RST}\n" "$(box_pad)" ""; }
box_mid() { printf "%*s${DIM}├${HR}┤${RST}\n" "$(box_pad)" ""; }
box_bot() { printf "%*s${DIM}└${HR}┘${RST}\n" "$(box_pad)" ""; }

# Left-aligned content row: │ TEXT (padded to BOX_INNER) │
# TEXT must be plain ASCII/UTF-8 with no ANSI codes (used for length calc)
box_row() {
  local TEXT="$1"
  local CLR="${2:-}"
  local TLEN=$(char_len "$TEXT")
  local RPAD=$(( BOX_INNER - TLEN ))
  [ "$RPAD" -lt 0 ] && RPAD=0
  printf "%*s${DIM}│${RST}${CLR}%s${RST}%*s${DIM}│${RST}\n" \
    "$(box_pad)" "" "$TEXT" "$RPAD" ""
}

# Centered content row
box_row_c() {
  local TEXT="$1"
  local CLR="${2:-}"
  local TLEN=$(char_len "$TEXT")
  local LPAD=$(( (BOX_INNER - TLEN) / 2 ))
  local RPAD=$(( BOX_INNER - TLEN - LPAD ))
  [ "$LPAD" -lt 0 ] && LPAD=0
  [ "$RPAD" -lt 0 ] && RPAD=0
  printf "%*s${DIM}│${RST}%*s${CLR}%s${RST}%*s${DIM}│${RST}\n" \
    "$(box_pad)" "" "$LPAD" "" "$TEXT" "$RPAD" ""
}

# ── Header — always called DIRECTLY, never inside $() ────────────────────────

draw_header() {
  local IP VER ALPINE
  IP=$(get_ip)
  VER=$(get_version)
  ALPINE=$(get_alpine_ver)

  clear
  printf "\n"
  box_top
  box_row_c "PCD Ops  |  Platform9 Operations Dashboard" "${BOLD}${WHT}"
  box_mid
  if is_running; then
    box_row_c "●  Service Running" "${GRN}${BOLD}"
  else
    box_row_c "●  Service Stopped" "${RED}${BOLD}"
  fi
  box_row ""
  box_row "  Version:     ${VER}"
  box_row "  IP Address:  ${IP:-not assigned}"
  box_row "  Web URL:     http://${IP:-<not assigned>}/"
  box_row "  System:      Alpine Linux v${ALPINE}" "${DIM}"
  box_mid
}

draw_advanced_header() {
  clear
  printf "\n"
  box_top
  box_row_c "Advanced Options" "${BBLU}${BOLD}"
  box_mid
}

# ── Menu functions — only gum choose, safe to capture with $() ───────────────

pick_main_menu() {
  gum choose \
    --header "  APPLIANCE MENU" \
    --header.foreground "$C_BLUE" \
    --header.bold \
    --cursor ">  " \
    --cursor.foreground "$C_YELLOW" \
    --selected.foreground "$C_WHITE" \
    --height 6 \
    "  Restart App" \
    "  Reboot Appliance" \
    "  Shutdown" \
    "  Advanced Options"
}

pick_advanced_menu() {
  gum choose \
    --header "  Select an option" \
    --header.foreground "$C_DIM" \
    --cursor ">  " \
    --cursor.foreground "$C_YELLOW" \
    --selected.foreground "$C_WHITE" \
    --height 8 \
    "  Force App Update  (git pull + rebuild)" \
    "  Patch OS  (apk update + upgrade)" \
    "  View App Logs" \
    "  Network Info" \
    "  Emergency Shell" \
    "  Back"
}

# ── Pause ─────────────────────────────────────────────────────────────────────

pause() {
  printf "\n${DIM}  Press Enter to return to menu...${RST}"
  read -r _
}

# ── Actions ───────────────────────────────────────────────────────────────────

do_restart() {
  if gum confirm \
    --prompt.foreground "$C_WHITE" \
    --affirmative "Restart" \
    --negative "Cancel" \
    --default=false \
    "Restart the pcd-ops service?"; then
    gum spin --spinner dot --title "  Restarting pcd-ops…" -- rc-service pcd-ops restart
    printf "\n  ${GRN}${BOLD}✓  Service restarted.${RST}\n"
    sleep 1
  fi
}

do_reboot() {
  if gum confirm \
    --affirmative "Reboot" \
    --negative "Cancel" \
    --default=false \
    "Reboot the appliance?"; then
    gum spin --spinner dot --title "  Rebooting in 3 seconds — Ctrl+C to abort…" -- sleep 3
    reboot
  fi
}

do_shutdown() {
  if gum confirm \
    --affirmative "Shutdown" \
    --negative "Cancel" \
    --default=false \
    "Shut down the appliance?"; then
    gum spin --spinner dot --title "  Shutting down in 3 seconds — Ctrl+C to abort…" -- sleep 3
    poweroff
  fi
}

do_force_update() {
  clear
  printf "\n"
  box_top
  box_row_c "Force App Update" "${BBLU}${BOLD}"
  box_row_c "git pull + pip install + npm build + service restart" "${DIM}"
  box_bot
  printf "\n"

  if su -s /bin/sh pcd-ops -c "PCD_OPS_DIR=$APP_DIR $APP_DIR/deploy/scripts/update.sh"; then
    printf "\n  ${GRN}${BOLD}✓  Update completed successfully.${RST}\n"
  else
    printf "\n  ${RED}${BOLD}✗  Update failed — see output above.${RST}\n"
  fi
  pause
}

do_patch_os() {
  clear
  printf "\n"
  box_top
  box_row_c "Patch Alpine Linux" "${BBLU}${BOLD}"
  box_row_c "apk update && apk upgrade" "${DIM}"
  box_bot
  printf "\n"

  apk update && apk upgrade
  if [ $? -eq 0 ]; then
    printf "\n  ${GRN}${BOLD}✓  OS patch complete.${RST}\n"
  else
    printf "\n  ${RED}${BOLD}✗  OS patch failed — see output above.${RST}\n"
  fi
  pause
}

do_view_logs() {
  clear
  printf "\n"
  box_top
  box_row_c "App Logs" "${BBLU}${BOLD}"
  box_row_c "/var/log/pcd-ops/uvicorn.log — last 100 lines  (q to exit)" "${DIM}"
  box_bot
  printf "\n"

  if [ -f /var/log/pcd-ops/uvicorn.log ]; then
    tail -n 100 /var/log/pcd-ops/uvicorn.log | less
  else
    printf "\n  ${YEL}Log file not found — service may not have started yet.${RST}\n"
  fi
  pause
}

do_network_info() {
  clear
  printf "\n"
  box_top
  box_row_c "Network Information" "${BBLU}${BOLD}"
  box_bot
  printf "\n"
  ip -4 addr show 2>/dev/null
  printf "\n"
  ip route show 2>/dev/null
  pause
}

do_emergency_shell() {
  clear
  printf "\n"
  box_top
  box_row_c "Emergency Shell" "${RED}${BOLD}"
  box_bot
  printf "\n  ${YEL}Dropping to root shell. Type ${BOLD}exit${RST}${YEL} to return.${RST}\n\n"
  /bin/sh
}

# ── Advanced loop ─────────────────────────────────────────────────────────────

advanced_loop() {
  while true; do
    draw_advanced_header
    CHOICE=$(pick_advanced_menu)
    box_bot
    case "$CHOICE" in
      *"Force App Update"*)  do_force_update ;;
      *"Patch OS"*)          do_patch_os ;;
      *"View App Logs"*)     do_view_logs ;;
      *"Network Info"*)      do_network_info ;;
      *"Emergency Shell"*)   do_emergency_shell ;;
      *"Back"*|"")           return ;;
    esac
  done
}

# ── Main loop ─────────────────────────────────────────────────────────────────

while true; do
  draw_header
  CHOICE=$(pick_main_menu)
  box_bot
  case "$CHOICE" in
    *"Restart App"*)       do_restart ;;
    *"Reboot Appliance"*)  do_reboot ;;
    *"Shutdown"*)          do_shutdown ;;
    *"Advanced Options"*)  advanced_loop ;;
    "")                    continue ;;
  esac
done
