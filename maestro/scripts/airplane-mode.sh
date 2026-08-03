#!/usr/bin/env bash
# Toggles airplane mode on a single connected Android emulator/device.
# Usage: airplane-mode.sh on|off
# iOS simulators are not supported (no airplane API) — see docs/mobile/e2e.md.
set -euo pipefail

state="${1:?usage: airplane-mode.sh on|off}"
case "$state" in
  on) flag=1; bool=true ;;
  off) flag=0; bool=false ;;
  *) echo "usage: airplane-mode.sh on|off" >&2; exit 2 ;;
esac

adb shell settings put global airplane_mode_on "$flag"
adb shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state "$bool"
