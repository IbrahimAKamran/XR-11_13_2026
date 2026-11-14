#!/usr/bin/env bash
# FieldAssist dev runner.
# 1. Starts the ingest server on this Mac (receives transcripts + raw audio from the phone).
# 2. Builds the miniapp with the ingest URL baked in, serves it over your LAN, prints a QR
#    code, and streams the phone's console output into this terminal.
# Extra arguments go to the CLI, e.g. ./run.sh --usb [--device <serial>] (Android over adb).
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is not installed. Install it with: brew install oven-sh/bun/bun" >&2
  exit 1
fi
[ -d node_modules ] || bun install

# Optional overrides (see .env.example). Values in .env win over the shell environment.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

PACKAGE=$(grep -o '"packageName": *"[^"]*"' miniapp.json | sed 's/.*: *"//; s/"$//')
PORT=$(grep -o '"port": *[0-9]*' miniapp.json | grep -o '[0-9]*$' || true)
PORT=${PORT:-3000}
INGEST_PORT=${INGEST_PORT:-3100}

# Same interface choice as the CLI's QR code (prefers real Wi-Fi/Ethernet, skips VPN tunnels).
LAN_IP=$(bun -e 'import {getLanIp} from "@mentra/miniapp-cli/lan"; console.log(getLanIp() ?? "")' 2>/dev/null || true)
if [ -z "$LAN_IP" ]; then
  LAN_IP=$(ipconfig getifaddr "$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')" 2>/dev/null || true)
fi

USB=0
DEVICE=""
prev=""
for arg in "$@"; do
  [ "$arg" = "--usb" ] && USB=1
  [ "$prev" = "--device" ] && DEVICE="$arg"
  prev="$arg"
done

# USB mode (Android): the CLI runs `adb reverse` for its own two ports so the QR can
# point at the phone's loopback. Do the same for the ingest port, against the same
# device the CLI would pick (the glasses also appear over adb as 0123456789ABCDEF).
ADB_S=""
if [ "$USB" = 1 ]; then
  if command -v adb >/dev/null 2>&1; then
    if [ -n "$DEVICE" ]; then
      ADB_S="-s $DEVICE"
    else
      serials=$(adb devices 2>/dev/null | awk 'NR>1 && $2=="device" && $1!="0123456789ABCDEF"{print $1}')
      if [ "$(printf '%s\n' "$serials" | grep -c .)" = 1 ]; then ADB_S="-s $serials"; fi
    fi
    # shellcheck disable=SC2086
    if [ "$(adb $ADB_S get-state 2>/dev/null || true)" != "device" ]; then
      echo "warning: no Android device visible to adb; using the Wi-Fi address for the ingest URL instead" >&2
      USB=0
    fi
  else
    echo "warning: adb not found (brew install --cask android-platform-tools); using the Wi-Fi address instead" >&2
    USB=0
  fi
fi

if [ -z "${MENTRA_PUBLIC_INGEST_URL:-}" ]; then
  if [ "$USB" = 1 ]; then
    MENTRA_PUBLIC_INGEST_URL="http://127.0.0.1:$INGEST_PORT"
  elif [ -n "$LAN_IP" ]; then
    MENTRA_PUBLIC_INGEST_URL="http://$LAN_IP:$INGEST_PORT"
  else
    echo "Could not detect a LAN IP. Join Wi-Fi, or set MENTRA_PUBLIC_INGEST_URL in .env." >&2
    exit 1
  fi
fi
export MENTRA_PUBLIC_INGEST_URL INGEST_PORT

echo "FieldAssist dev server"
echo "  package : $PACKAGE   (change it in miniapp.json; dev entries on the phone are keyed by it)"
if [ "$USB" = 1 ]; then
  echo "  USB     : phone reached over adb reverse${ADB_S:+ (adb $ADB_S)}; keep the cable plugged in"
else
  echo "  Wi-Fi   : your phone must be on the same Wi-Fi network as this Mac"
fi
echo "  ports   : $PORT (miniapp files) and $((PORT + 1)) (live reload + console output back to this terminal);"
echo "            if they are busy the CLI picks the next free pair and prints it"
echo "  ingest  : $MENTRA_PUBLIC_INGEST_URL  (baked into the bundle; raw audio + transcripts arrive here)"
echo "  ngrok   : not needed; nothing leaves your LAN"
echo
echo "On the phone, in the Mentra App: Settings -> Miniapp Developer Settings -> Scan Miniapp QR Code,"
echo "then scan the QR printed below. The 'Miniapp URL' the CLI prints is the authoritative address."
echo "If you do not see that menu, update the Mentra App."
echo "Transcript lines appear here twice: [MentraJS] (phone console) and [ingest] (received over the uplink)."
echo "Audio stats and the recording path appear as [ingest] lines. Ctrl+C stops everything."
echo

INGEST_PORT="$INGEST_PORT" bun run server/ingest.ts &
INGEST_PID=$!
ADB_LOOP_PID=""
if [ "$USB" = 1 ]; then
  # Re-assert the reverse mapping every 5 s: adb drops it on unplug, reboot, or `adb kill-server`.
  # shellcheck disable=SC2086
  (while true; do adb $ADB_S reverse "tcp:$INGEST_PORT" "tcp:$INGEST_PORT" >/dev/null 2>&1 || true; sleep 5; done) &
  ADB_LOOP_PID=$!
fi
cleanup() {
  kill "$INGEST_PID" 2>/dev/null || true
  [ -n "$ADB_LOOP_PID" ] && kill "$ADB_LOOP_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

bun run dev "$@"
