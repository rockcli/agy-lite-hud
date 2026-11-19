#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.local.agy-lite-hud"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LEGACY_PLIST="$HOME/Library/LaunchAgents/io.github.rock.agy-lite-hud.plist"

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/io.github.rock.agy-lite-hud" 2>/dev/null || true
rm -f "$PLIST" "$LEGACY_PLIST"
node "$DIR/watcher.mjs" --remove || true
echo "Uninstalled ${LABEL}"
