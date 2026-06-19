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
BGBLU='\033[44m'  # bg blue (for title bar)

# gum color indices (ANSI 0-15, safe for TERM=linux)
C_BLUE="4"
C_GREEN="10"
C_RED="9"
C_YELLOW="11"
C_DIM="8"
C_WHITE="15"

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

center_text() {
  # center_text TEXT [WIDTH]  — TEXT must be plain (no ANSI) for length calc
  local TEXT="$1"
  local COLS="${2:-$(term_cols)}"
  local LEN=${#TEXT}
  local PAD=$(( (COLS - LEN) / 2 ))
  [ "$PAD" -lt 0 ] && PAD=0
  printf "%*s%s\n" "$PAD" "" "$TEXT"
}

hline() {
  local COLS=$(term_cols)
  local CHAR="${1:--}"
  printf "${DIM}"
  printf '%*s' "$COLS" '' | tr ' ' "$CHAR"
  printf "${RST}\n"
}

# ── Main header — always called DIRECTLY (never inside $()) ──────────────────

draw_header() {
  local IP VER ALPINE COLS TITLE PAD INFO_PAD FIELD_W INFO_W

  IP=$(get_ip)
  VER=$(get_version)
  ALPINE=$(get_alpine_ver)
  COLS=$(term_cols)

  clear

  # ── Title bar: blue bg, full width ─────────────────────────────────────
  TITLE="  PCD Ops  |  Platform9 Operations Dashboard  "
  local TLEN=${#TITLE}
  PAD=$(( (COLS - TLEN) / 2 ))
  [ "$PAD" -lt 0 ] && PAD=0
  printf "${BGBLU}${WHT}${BOLD}"
  printf "%*s%s%*s" "$PAD" "" "$TITLE" $(( COLS - TLEN - PAD )) ""
  printf "${RST}\n\n"

  # ── Service status ──────────────────────────────────────────────────────
  if is_running; then
    local STATUS_TXT="●  Service Running"
    local STATUS_CLR="${GRN}${BOLD}"
  else
    local STATUS_TXT="●  Service Stopped"
    local STATUS_CLR="${RED}${BOLD}"
  fi
  local SLEN=${#STATUS_TXT}
  local SPAD=$(( (COLS - SLEN) / 2 ))
  [ "$SPAD" -lt 0 ] && SPAD=0
  printf "%*s${STATUS_CLR}%s${RST}\n\n" "$SPAD" "" "$STATUS_TXT"

  # ── Info block ──────────────────────────────────────────────────────────
  FIELD_W=12
  INFO_W=$(( FIELD_W + 32 ))
  INFO_PAD=$(( (COLS - INFO_W) / 2 ))
  [ "$INFO_PAD" -lt 2 ] && INFO_PAD=2

  local WEB="http://${IP:-<not assigned>}/"
  printf "%*s${DIM}%-${FIELD_W}s${RST} ${BOLD}%s${RST}\n" \
    "$INFO_PAD" "" "IP Address:" "${IP:-not assigned}"
  printf "%*s${DIM}%-${FIELD_W}s${RST} ${BOLD}%s${RST}\n" \
    "$INFO_PAD" "" "Web URL:" "$WEB"
  printf "%*s${DIM}%-${FIELD_W}s${RST} Alpine v${ALPINE}  |  Build: ${VER}\n" \
    "$INFO_PAD" "" "System:"

  printf "\n"
  hline "-"
  printf "\n"
}

# ── Advanced header — also called directly ────────────────────────────────────

draw_advanced_header() {
  local COLS=$(term_cols)
  clear
  printf "\n"
  local TXT="Advanced Options"
  local TLEN=${#TXT}
  local PAD=$(( (COLS - TLEN) / 2 ))
  [ "$PAD" -lt 0 ] && PAD=0
  printf "%*s${BBLU}${BOLD}%s${RST}\n\n" "$PAD" "" "$TXT"
  hline "-"
  printf "\n"
}

# ── Menu functions — only run gum choose (safe to capture with $()) ───────────

pick_main_menu() {
  gum choose \
    --header "   APPLIANCE MENU" \
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
    --header "   Select an option" \
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
  local COLS=$(term_cols)
  clear
  printf "\n"
  local TXT="Force App Update"
  printf "%*s${BBLU}${BOLD}%s${RST}\n\n" "$(( (COLS - ${#TXT}) / 2 ))" "" "$TXT"
  hline "-"
  printf "\n  ${DIM}git pull + pip install + npm build + service restart${RST}\n\n"

  if su -s /bin/sh pcd-ops -c "PCD_OPS_DIR=$APP_DIR $APP_DIR/deploy/scripts/update.sh"; then
    printf "\n  ${GRN}${BOLD}✓  Update completed successfully.${RST}\n"
  else
    printf "\n  ${RED}${BOLD}✗  Update failed — see output above.${RST}\n"
  fi
  pause
}

do_patch_os() {
  local COLS=$(term_cols)
  clear
  printf "\n"
  local TXT="Patch Alpine Linux"
  printf "%*s${BBLU}${BOLD}%s${RST}\n\n" "$(( (COLS - ${#TXT}) / 2 ))" "" "$TXT"
  hline "-"
  printf "\n  ${DIM}apk update && apk upgrade${RST}\n\n"

  apk update && apk upgrade
  if [ $? -eq 0 ]; then
    printf "\n  ${GRN}${BOLD}✓  OS patch complete.${RST}\n"
  else
    printf "\n  ${RED}${BOLD}✗  OS patch failed — see output above.${RST}\n"
  fi
  pause
}

do_view_logs() {
  local COLS=$(term_cols)
  clear
  printf "\n"
  local TXT="App Logs"
  printf "%*s${BBLU}${BOLD}%s${RST}\n" "$(( (COLS - ${#TXT}) / 2 ))" "" "$TXT"
  printf "\n  ${DIM}/var/log/pcd-ops/uvicorn.log — last 100 lines. Press q to exit.${RST}\n"
  hline "-"

  if [ -f /var/log/pcd-ops/uvicorn.log ]; then
    tail -n 100 /var/log/pcd-ops/uvicorn.log | less
  else
    printf "\n  ${YEL}Log file not found — service may not have started yet.${RST}\n"
  fi
  pause
}

do_network_info() {
  local COLS=$(term_cols)
  clear
  printf "\n"
  local TXT="Network Information"
  printf "%*s${BBLU}${BOLD}%s${RST}\n\n" "$(( (COLS - ${#TXT}) / 2 ))" "" "$TXT"
  hline "-"
  printf "\n"
  ip -4 addr show 2>/dev/null
  printf "\n"
  ip route show 2>/dev/null
  pause
}

do_emergency_shell() {
  local COLS=$(term_cols)
  clear
  printf "\n"
  local TXT="Emergency Shell"
  printf "%*s${RED}${BOLD}%s${RST}\n\n" "$(( (COLS - ${#TXT}) / 2 ))" "" "$TXT"
  hline "-"
  printf "\n  ${YEL}Dropping to root shell. Type ${BOLD}exit${RST}${YEL} to return to the appliance menu.${RST}\n\n"
  /bin/sh
}

# ── Advanced loop ─────────────────────────────────────────────────────────────

advanced_loop() {
  while true; do
    draw_advanced_header          # draws directly to terminal
    CHOICE=$(pick_advanced_menu)  # captures only the selection
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
  draw_header              # draws directly to terminal — never captured
  CHOICE=$(pick_main_menu) # $() only captures gum's selection text
  case "$CHOICE" in
    *"Restart App"*)       do_restart ;;
    *"Reboot Appliance"*)  do_reboot ;;
    *"Shutdown"*)          do_shutdown ;;
    *"Advanced Options"*)  advanced_loop ;;
    "")                    continue ;;
  esac
done
