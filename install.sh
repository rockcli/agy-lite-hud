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

LABEL="com.local.agy-lite-hud"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LEGACY_PLIST="$HOME/Library/LaunchAgents/io.github.rock.agy-lite-hud.plist"

# Clean up legacy LaunchAgent label if upgrading
launchctl bootout "gui/$(id -u)/io.github.rock.agy-lite-hud" 2>/dev/null || true
rm -f "$LEGACY_PLIST"

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

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed & started ${LABEL}"
