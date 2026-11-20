#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "Error: node not found in PATH (Node.js 22+ required)" >&2
  exit 1
fi
if ! "$NODE_BIN" -e "if (typeof WebSocket !== 'function') process.exit(1)" 2>/dev/null; then
  echo "Error: Node.js 22+ with built-in WebSocket is required (found $("$NODE_BIN" -v))" >&2
  exit 1
fi

LABEL="com.local.antigravity-office"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LEGACY_LABELS=("com.local.agy-lite-hud" "io.github.rock.agy-lite-hud")

# Clean up legacy LaunchAgent labels if upgrading
for old in "${LEGACY_LABELS[@]}"; do
  launchctl bootout "${DOMAIN}/${old}" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/${old}.plist"
done

# Unload existing service and wait for launchd teardown before rewriting plist
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
for _ in $(seq 1 25); do
  if ! launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${DIR}/watcher.mjs</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${DIR}/watcher.log</string>
  <key>StandardErrorPath</key>
  <string>${DIR}/watcher.log</string>
</dict>
</plist>
EOF

launchctl enable "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "${DOMAIN}" "$PLIST"
echo "Installed & started ${LABEL}"
