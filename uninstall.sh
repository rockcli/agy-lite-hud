#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.local.antigravity-office"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LEGACY_LABELS=("com.local.agy-lite-hud" "io.github.rock.agy-lite-hud")

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
rm -f "$PLIST"
for old in "${LEGACY_LABELS[@]}"; do
  launchctl bootout "gui/$(id -u)/${old}" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/${old}.plist"
done
node "$DIR/watcher.mjs" --remove || true
echo "Uninstalled ${LABEL}"
