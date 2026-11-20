<div align="center">

<img src="docs/icon.png" alt="antigravity-office icon" width="76" height="76" />

# antigravity-office

**Lightweight, zero-dependency 2.5D Pixel Agent Office & CDP HUD for Google Antigravity (macOS).**

[![macOS](https://img.shields.io/badge/macOS-13%2B-000000?logo=apple&logoColor=white)](https://github.com/rockcli/antigravity-office)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

<br />

<img src="docs/screenshot.png" alt="antigravity-office Pixel Agent Office screenshot" width="680" />

</div>

## Features

- 🏢 **2.5D Pixel Agent Office** — Hides the native home greeting/logo clutter and mounts an isometric **AGENT 工作室** studio on the New Conversation page with 3 mainstream agent workstations (**Gemini**, **Claude**, **ChatGPT**) + 1 **Open Flex Desk** (Slot 4: auto-hosts **OpenCode** or **DSH**, extensible for more agents), subagent helper bots, a 3-blade corner server rack (`00N` background tasks, Colab CU readout, pixel cat eyes), and a live wall leaderboard. Uninstalled agents gracefully degrade to clean empty desks with onboarding hints instead of idle characters (and are excluded from gong cheers and the leaderboard).
- 🖥️ **Holographic Status Projection & One-Click Handoff** — Click an active/unread agent and they stand up pointing to a floating holographic status screen (`状态投屏`): inspect tasks, copy resume commands (`claude --resume` / `codex resume`), mark items reviewed, or hand off context directly into the Antigravity composer (click outside or press `Esc` to close; cross-agent delegated sub-tasks animate as working without polluting unread).
- 📚 **Daily Dispatch Book Stacks** — Color-coded isometric books stacked on each desk visualize today's task dispatches by source (direct user prompts vs cross-agent dispatches, resetting daily at `00:00`).
- 🟢 **Flicker-Free Context Remaining Ring** — Injects a clean context-remaining ring right beside the composer `+` (*Add context*) button with live draft-token estimation while typing and smooth same-frame updates.
- 🌿 **Compact Sidebar Branch Icon** — Collapses the second-line git branch/worktree label in sidebar conversation rows into a crisp `13x13` branch icon.
- ⚡ **Local Speed Sample Export** — Writes completed generation samples (`id`, `model`, `outputTokens`, `ttft`, `stream`, `completedAt`) locally to `~/.config/howmanyusage/agy-speed.json`.

## Optional Local Integrations

`antigravity-office` works standalone out of the box: uninstalled agents render as clean empty desks with onboarding tips, missing external session sources are skipped silently, and the wall whiteboard shows a decorative pixel bar & line chart when `howmanyusage` is not installed:

| Integration | Local Source | What It Enables |
|---|---|---|
| **Claude Code** | `~/.claude/projects` | Live & recent Claude sessions on Desk 2 |
| **Codex CLI** | `~/.codex/sessions` | Live & recent Codex threads on Desk 3 |
| **OpenCode** | `~/.local/share/opencode/opencode.db` (or legacy `storage/session`) | Live & recent OpenCode sessions on the Open Flex Desk (Desk 4) |
| **DSH** | `~/.dsh` & `dsh-session-bridge` | DSH sessions on the Open Flex Desk (Desk 4); auto-prioritized by recent activity when multiple Desk-4 agents exist, or pin via `AG_SLOT4_AGENT=opencode\|dsh` or the in-app pill |
| **[HowManyUsage](https://github.com/rockcli/howmanyusage)** | `~/.config/howmanyusage/{usage-history.json,state.json}` | In-screen stamina bar, quota-exhaustion strike alerts, Colab CU on the server rack, and live wall leaderboard |

> Note: The in-app Pixel Agent Office UI copy is currently in Simplified Chinese.

## Quick Start

Requires **macOS**, **Node.js 22+** (built-in `WebSocket` & `fetch`), and **Google Antigravity** running with CDP enabled (reads `~/Library/Application Support/Antigravity/DevToolsActivePort`, or override via `AG_CDP_PORT`).

```bash
git clone https://github.com/rockcli/antigravity-office.git
cd antigravity-office
./install.sh
```

`./install.sh` registers and starts a `LaunchAgent` (`com.local.antigravity-office`) that watches local files and auto-reloads changes into Antigravity.

**Manual / one-shot usage:**

```bash
node watcher.mjs --once     # inject once and exit
node watcher.mjs --remove   # remove injected DOM and styles
```

**Uninstall:**

```bash
./uninstall.sh
```

## Disclaimer

This project injects local CSS/JS into your running Antigravity desktop client via Chrome DevTools Protocol (`127.0.0.1`), reads local session/state files on your Mac, and writes only local speed samples (`~/.config/howmanyusage/agy-speed.json`) plus `watcher.log`. Zero telemetry, zero external network requests. Internal DOM selectors and store shapes may change with Antigravity updates.

## License

[MIT](LICENSE) © [rockcli](https://github.com/rockcli)
