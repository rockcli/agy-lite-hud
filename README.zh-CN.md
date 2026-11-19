<div align="center">

<img src="docs/icon.png" alt="agy-lite-hud icon" width="76" height="76" />

# agy-lite-hud

**轻量、零依赖的 Google Antigravity (macOS) CDP 增强面板与 2.5D 像素工位看板。**

[![macOS](https://img.shields.io/badge/macOS-13%2B-000000?logo=apple&logoColor=white)](https://github.com/rockcli/agy-lite-hud)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) | 简体中文

<br />

<img src="docs/screenshot.png" alt="agy-lite-hud 像素工位看板截图" width="680" />

</div>

## 核心特性

- 🏢 **2.5D 像素 Agent 办公室** — 将 Antigravity 的新对话首页改造成等距像素办公室，实时展示 **Gemini**、**Claude**、**ChatGPT**、**DeepSeek** 四个工位状态、角落机房后台任务，以及墙面销冠榜。
- 📬 **汇报夹与一键交接** — 点击任意工位可查看进行中/待批阅任务，一键复制续写命令（`claude --resume` / `codex resume`）、标记已批阅，或把上下文直接填入 Antigravity 输入框继续处理。
- 🟢 **上下文余量指示环** — 在输入框 `+`（Add context）按钮旁注入极简上下文余量圆环，不占用额外空间。
- 🌿 **侧边栏分支精简图标** — 收起侧边栏对话行第二行的分支/worktree 文字，仅保留紧凑的 `13x13` 分支图标。
- ⚡ **本地测速采样导出** — 纯本地记录每次生成的测速样本（`id`、`model`、`outputTokens`、`ttft`、`stream`、`completedAt`）至 `~/.config/howmanyusage/agy-speed.json`。

## 可选本地联动

`agy-lite-hud` 可独立开箱即用，未安装的本地数据源会自动跳过、不报错：

| 联动工具 | 读取的本地路径 | 增强效果 |
|---|---|---|
| **Claude Code** | `~/.claude/projects` | 在 Claude 工位展示近期/运行中会话 |
| **Codex CLI** | `~/.codex/sessions` | 在 ChatGPT 工位展示近期/运行中线程 |
| **DSH** | `~/.agents/skills/dsh-session-bridge` | 在 DeepSeek 工位展示 DSH 会话 |
| **[HowManyUsage](https://github.com/rockcli/howmanyusage)** | `~/.config/howmanyusage/{usage-history.json,state.json}` | 桌面体力积木、额度耗尽罢工提醒、机房 Colab CU 与墙面销冠榜 |

## 快速开始

环境要求：**macOS**、**Node.js 22+**（内置 `WebSocket` 与 `fetch`），以及已开启 CDP 调试端口的 **Google Antigravity**（自动读取 `~/Library/Application Support/Antigravity/DevToolsActivePort`，也可通过环境变量 `AG_CDP_PORT` 指定）。

```bash
git clone https://github.com/rockcli/agy-lite-hud.git
cd agy-lite-hud
./install.sh
```

`./install.sh` 会注册并启动 `LaunchAgent`（`com.local.agy-lite-hud`），监听本地文件改动并自动热更新注入到 Antigravity。

**手动 / 单次命令：**

```bash
node watcher.mjs --once     # 单次注入后退出
node watcher.mjs --remove   # 卸载已注入的 DOM 与样式
```

**卸载：**

```bash
./uninstall.sh
```

## 免责声明

本工具仅通过本机 Chrome DevTools Protocol（`127.0.0.1`）向运行中的 Antigravity 桌面端注入本地样式与脚本，并只读本地会话与状态文件；无遥测、无外部网络请求。内部 DOM 选择器与前端 Store 结构可能随 Antigravity 版本更新而变化。

## 许可证

[MIT](LICENSE) © [rockcli](https://github.com/rockcli)
