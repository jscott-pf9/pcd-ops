#!/bin/sh
# PCD Ops Appliance Console — gum edition (sample)
# Requires: gum (apk add gum)
# On full-color terminals set TERM=xterm-256color for best rendering;
# TERM=linux (VGA console) works but gum approximates hex colors to 8-color ANSI.

export TERM="${TERM:-xterm-256color}"
APP_DIR="/opt/pcd-ops"

# ── Palette ───────────────────────────────────────────────────────────────────
BLUE="63"       # ANSI 256: closest to Platform9 #0076FF that renders on Linux console
GREEN="71"      # ANSI 256: muted green
RED="167"       # ANSI 256: soft red
AMBER="214"     # ANSI 256: amber / yellow-orange
DIM="240"       # ANSI 256: dark grey

# ── Helpers ───────────────────────────────────────────────────────────────────

get_ip() {
  ip -4 addr show scope global 2>/dev/null \
    | awk '/inet /{print $2}' | cut -d/ -f1 | head -1
}

is_running() {
  rc-service pcd-ops status >/dev/null 2>&1
}

get_version() {
  git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown"
}

get_alpine_ver() {
  cat /etc/alpine-release 2>/dev/null || echo "unknown"
}

# ── Header ────────────────────────────────────────────────────────────────────

draw_header() {
  IP=$(get_ip)
  VER=$(get_version)
  ALPINE=$(get_alpine_ver)

  clear

  gum style \
    --border rounded \
    --border-foreground "$BLUE" \
    --padding "0 2" \
    --margin "1 4 0 4" \
    --bold \
    --foreground "$BLUE" \
    "PCD Ops  —  Platform9 Operations Dashboard"

  if is_running; then
    STATUS=$(gum style --foreground "$GREEN" "● Running")
  else
    STATUS=$(gum style --foreground "$RED" "● Stopped")
  fi

  gum style --margin "0 6" \
    "${STATUS}
$(gum style --foreground "$DIM" "IP:    ")$(gum style --bold "${IP:-not assigned}")
$(gum style --foreground "$DIM" "Web:   ")$(gum style --bold "http://${IP:-<not assigned>}/")
$(gum style --foreground "$DIM" "Build: ")${VER}  $(gum style --foreground "$DIM" "Alpine:") v${ALPINE}"

  echo ""
}

# ── Main menu ─────────────────────────────────────────────────────────────────

main_menu() {
  draw_header

  gum choose \
    --header "  Appliance Menu" \
    --header.foreground "$BLUE" \
    --header.bold \
    --cursor "▸ " \
    --cursor.foreground "$AMBER" \
    --selected.foreground "$BLUE" \
    --height 6 \
    "Restart App" \
    "Reboot Appliance" \
    "Shutdown" \
    "Advanced Options"
}

# ── Advanced menu ─────────────────────────────────────────────────────────────

advanced_menu() {
  draw_header

  gum style \
    --foreground "$BLUE" \
    --bold \
    --margin "0 4 0 4" \
    "Advanced Options"

  gum choose \
    --header "  Select an option" \
    --header.foreground "$DIM" \
    --cursor "▸ " \
    --cursor.foreground "$AMBER" \
    --selected.foreground "$BLUE" \
    --height 8 \
    "Force App Update  (git pull + rebuild)" \
    "Patch OS  (apk update + upgrade)" \
    "View App Logs" \
    "Network Info" \
    "Emergency Shell" \
    "← Back"
}

# ── Shared: wait for enter ─────────────────────────────────────────────────────

pause() {
  gum input --placeholder "  Press Enter to return to menu…" > /dev/null 2>&1 \
    || read -r _dummy
}

# ── Actions ───────────────────────────────────────────────────────────────────

do_restart() {
  if gum confirm \
    --affirmative "Restart" \
    --negative "Cancel" \
    --default=false \
    "Restart the pcd-ops service?"; then
    gum spin --spinner dot --title " Restarting pcd-ops…" -- rc-service pcd-ops restart
    gum style --foreground "$GREEN" --margin "1 4" "✓  Service restarted."
    sleep 1
  fi
}

do_reboot() {
  if gum confirm \
    --affirmative "Reboot" \
    --negative "Cancel" \
    --default=false \
    "Reboot the appliance?"; then
    gum spin --spinner dot --title " Rebooting in 3 seconds — Ctrl+C to abort…" -- sleep 3
    reboot
  fi
}

do_shutdown() {
  if gum confirm \
    --affirmative "Shutdown" \
    --negative "Cancel" \
    --default=false \
    "Shut down the appliance?"; then
    gum spin --spinner dot --title " Shutting down in 3 seconds — Ctrl+C to abort…" -- sleep 3
    poweroff
  fi
}

do_force_update() {
  clear
  gum style --bold --foreground "$BLUE" --margin "1 4 0 4" "Force App Update"
  gum style --foreground "$DIM" --margin "0 6 1 6" \
    "git pull + pip install + npm build + service restart"

  if su -s /bin/sh pcd-ops -c "PCD_OPS_DIR=$APP_DIR $APP_DIR/deploy/scripts/update.sh"; then
    gum style --foreground "$GREEN" --margin "1 4" "✓  Update completed successfully."
  else
    gum style --foreground "$RED" --margin "1 4" "✗  Update failed — see output above."
  fi

  pause
}

do_patch_os() {
  clear
  gum style --bold --foreground "$BLUE" --margin "1 4 0 4" "Patch Alpine Linux"
  gum style --foreground "$DIM" --margin "0 6 1 6" "apk update && apk upgrade"

  apk update && apk upgrade
  if [ $? -eq 0 ]; then
    gum style --foreground "$GREEN" --margin "1 4" "✓  OS patch complete."
  else
    gum style --foreground "$RED" --margin "1 4" "✗  OS patch failed — see output above."
  fi

  pause
}

do_view_logs() {
  clear
  gum style --bold --foreground "$BLUE" --margin "1 4 0 4" "App Logs"
  gum style --foreground "$DIM" --margin "0 6 1 6" \
    "/var/log/pcd-ops/uvicorn.log — last 100 lines. Press q to exit."

  if [ -f /var/log/pcd-ops/uvicorn.log ]; then
    tail -n 100 /var/log/pcd-ops/uvicorn.log | less
  else
    gum style --foreground "$AMBER" --margin "1 4" \
      "Log file not found — service may not have started yet."
  fi

  pause
}

do_network_info() {
  clear
  gum style --bold --foreground "$BLUE" --margin "1 4 0 4" "Network Information"
  echo ""
  ip -4 addr show 2>/dev/null
  echo ""
  ip route show 2>/dev/null
  pause
}

do_emergency_shell() {
  clear
  gum style \
    --border rounded \
    --border-foreground "$RED" \
    --padding "0 2" \
    --margin "1 4" \
    --foreground "$RED" \
    --bold \
    "Emergency Shell"

  gum style --foreground "$AMBER" --margin "0 6" \
    "You are about to drop to a root shell.
Type 'exit' when done to return to the appliance menu."

  echo ""
  /bin/sh
}

# ── Advanced loop ─────────────────────────────────────────────────────────────

advanced_loop() {
  while true; do
    CHOICE=$(advanced_menu)
    case "$CHOICE" in
      "Force App Update"*)  do_force_update ;;
      "Patch OS"*)          do_patch_os ;;
      "View App Logs")      do_view_logs ;;
      "Network Info")       do_network_info ;;
      "Emergency Shell")    do_emergency_shell ;;
      "← Back"|"")         return ;;
    esac
  done
}

# ── Main loop ─────────────────────────────────────────────────────────────────

while true; do
  CHOICE=$(main_menu)
  case "$CHOICE" in
    "Restart App")       do_restart ;;
    "Reboot Appliance")  do_reboot ;;
    "Shutdown")          do_shutdown ;;
    "Advanced Options")  advanced_loop ;;
    "")                  continue ;;
  esac
done
