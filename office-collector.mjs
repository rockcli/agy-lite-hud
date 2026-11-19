import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HOME = os.homedir();
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RUNNING_WINDOW_MS = 45 * 1000;

const dshReplyCache = new Map(); // sessionId -> { asOfSeq, lastReply }

function shQuote(val) {
  return `'${String(val || '').replace(/'/g, `'\\''`)}'`;
}

function cleanText(raw, maxLen = 220) {
  if (!raw) return '';
  const s = String(raw)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

function projectFromCwd(cwd, fallback = '默认项目') {
  if (!cwd) return fallback;
  if (cwd.includes('/opus-review/jobs/')) return 'opus-review';
  if (cwd.includes('/codex-jobs/jobs/')) return 'codex-review';
  if (cwd.includes('/bridge-reviews/')) return 'dsh-review';
  const parts = cwd.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts[parts.length - 1] || fallback;
}

function readTail(filePath, maxBytes = 65536) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const st = fs.fstatSync(fd);
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readHead(filePath, maxBytes = 8192) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function findRecentJsonl(rootDir, maxDepth = 4, limit = 12) {
  const cutoff = Date.now() - MAX_AGE_MS;
  const found = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name === 'subagents') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
      } else if (e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs >= cutoff && st.size > 0) {
            found.push({ p, mtimeMs: st.mtimeMs });
          }
        } catch {}
      }
    }
  }
  walk(rootDir, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

function extractTextBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b) continue;
    if (typeof b === 'string') parts.push(b);
    else if (b.type === 'text' && b.text) parts.push(b.text);
    else if (b.type === 'output_text' && b.text) parts.push(b.text);
    else if (b.type === 'input_text' && b.text) parts.push(b.text);
  }
  return parts.join(' ');
}

function collectClaude() {
  const dir = path.join(HOME, '.claude/projects');
  if (!fs.existsSync(dir)) return [];
  const files = findRecentJsonl(dir, 3, 10);
  const now = Date.now();
  const items = [];

  for (const f of files) {
    try {
      const id = path.basename(f.p, '.jsonl');
      const tail = readTail(f.p, 65536);
      const lines = tail.split('\n').filter(Boolean);
      let cwd = '';
      let title = '';
      let lastReply = '';
      let ended = false;

      for (let i = lines.length - 1; i >= 0; i--) {
        let obj;
        try { obj = JSON.parse(lines[i]); } catch { continue; }
        if (!cwd && obj.cwd) cwd = obj.cwd;
        if (!title && obj.type === 'last-prompt' && obj.lastPrompt) {
          title = cleanText(obj.lastPrompt, 64);
        }
        if (!lastReply && obj.type === 'assistant' && obj.message?.content) {
          const txt = cleanText(extractTextBlocks(obj.message.content), 240);
          if (txt) lastReply = txt;
        }
        if (i >= lines.length - 4) {
          if (obj.type === 'cost-state' || obj.type === 'last-prompt') ended = true;
          if (obj.type === 'assistant' && (obj.message?.stop_reason === 'end_turn' || obj.message?.stop_reason === 'stop_sequence')) {
            ended = true;
          }
        }
      }

      if (!title) {
        const headLines = readHead(f.p, 8192).split('\n').filter(Boolean);
        for (const hl of headLines) {
          try {
            const o = JSON.parse(hl);
            if (!cwd && o.cwd) cwd = o.cwd;
            if (o.type === 'user' && o.message?.content) {
              const t = cleanText(extractTextBlocks(o.message.content), 64);
              if (t) { title = t; break; }
            }
          } catch {}
        }
      }

      const running = (now - f.mtimeMs) < RUNNING_WINDOW_MS && !ended;
      const project = projectFromCwd(cwd, 'Claude');
      const continueCmd = cwd
        ? `cd -- ${shQuote(cwd)} && claude --resume ${shQuote(id)}`
        : `claude --resume ${shQuote(id)}`;

      items.push({
        id,
        title: title || `Claude 会话 ${id.slice(0, 8)}`,
        project,
        running,
        waiting: false,
        updatedAt: Math.round(f.mtimeMs / 1000),
        lastReply: lastReply || (running ? '正在执行中…' : '暂无文字回复摘要'),
        continueCmd,
      });
    } catch {}
  }
  return items;
}

function collectCodex() {
  const sessionsRoot = path.join(HOME, '.codex/sessions');
  if (!fs.existsSync(sessionsRoot)) return [];

  // Only scan today and yesterday date folders for speed
  const dirsToScan = [];
  for (let d = 0; d < 2; d++) {
    const dt = new Date(Date.now() - d * 86400 * 1000);
    const yyyy = String(dt.getFullYear());
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    const p = path.join(sessionsRoot, yyyy, mm, dd);
    if (fs.existsSync(p)) dirsToScan.push(p);
  }

  const cutoff = Date.now() - MAX_AGE_MS;
  const files = [];
  for (const d of dirsToScan) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const p = path.join(d, e.name);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= cutoff && st.size > 0) files.push({ p, mtimeMs: st.mtimeMs });
      } catch {}
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const now = Date.now();
  const items = [];
  for (const f of files.slice(0, 10)) {
    try {
      const headLines = readHead(f.p, 12288).split('\n').filter(Boolean);
      let id = '';
      let cwd = '';
      let title = '';
      for (const hl of headLines) {
        try {
          const o = JSON.parse(hl);
          if (o.type === 'session_meta' && o.payload) {
            if (o.payload.id) id = o.payload.id;
            if (o.payload.cwd) cwd = o.payload.cwd;
          }
          if (!title && o.type === 'event_msg' && o.payload?.type === 'user_message' && o.payload?.message) {
            title = cleanText(o.payload.message, 64);
          }
          if (!title && o.type === 'response_item' && o.payload?.role === 'user' && o.payload?.content) {
            const t = cleanText(extractTextBlocks(o.payload.content), 64);
            if (t && !t.startsWith('# AGENTS.md') && !t.startsWith('<environment_context')) title = t;
          }
        } catch {}
      }
      if (!id) {
        const m = path.basename(f.p).match(/([0-9a-f-]{36})\.jsonl$/i);
        id = m ? m[1] : path.basename(f.p, '.jsonl');
      }

      const tailLines = readTail(f.p, 65536).split('\n').filter(Boolean);
      let lastReply = '';
      let ended = false;
      for (let i = tailLines.length - 1; i >= 0; i--) {
        let o;
        try { o = JSON.parse(tailLines[i]); } catch { continue; }
        if (i >= tailLines.length - 4) {
          if (o.type === 'event_msg' && (o.payload?.type === 'task_complete' || o.payload?.type === 'turn_aborted')) {
            ended = true;
          }
        }
        if (!lastReply && o.type === 'event_msg' && o.payload?.type === 'agent_message' && o.payload?.message) {
          lastReply = cleanText(o.payload.message, 240);
        }
        if (!lastReply && o.type === 'response_item' && o.payload?.role === 'assistant' && o.payload?.content) {
          const txt = cleanText(extractTextBlocks(o.payload.content), 240);
          if (txt) lastReply = txt;
        }
      }

      const running = (now - f.mtimeMs) < RUNNING_WINDOW_MS && !ended;
      const project = projectFromCwd(cwd, 'Codex');
      items.push({
        id,
        title: title || `Codex 线程 ${id.slice(0, 8)}`,
        project,
        running,
        waiting: false,
        updatedAt: Math.round(f.mtimeMs / 1000),
        lastReply: lastReply || (running ? '正在执行中…' : '暂无文字回复摘要'),
        continueCmd: `codex resume ${shQuote(id)}`,
      });
    } catch {}
  }
  return items;
}

async function collectDsh() {
  const script = path.join(HOME, '.agents/skills/dsh-session-bridge/scripts/dsh-session.mjs');
  if (!fs.existsSync(script)) return [];
  let rawList;
  try {
    const { stdout } = await execFileAsync(process.execPath, [script, 'list', '--limit', '10', '--json'], { timeout: 3500, maxBuffer: 4 * 1024 * 1024 });
    rawList = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(rawList)) return [];

  const cutoff = Date.now() - MAX_AGE_MS;
  const recent = rawList.filter((s) => s && !s.archived && !s.blank && (s.running || (s.updatedAt || 0) >= cutoff)).slice(0, 8);
  const items = [];

  for (const s of recent) {
    try {
      const id = String(s.sessionId || '').trim();
      if (!id) continue;
      let lastReply = '';
      const cached = dshReplyCache.get(id);
      if (cached && cached.asOfSeq === s.asOfSeq) {
        lastReply = cached.lastReply;
      } else if (items.length < 5) {
        try {
          const { stdout } = await execFileAsync(process.execPath, [script, 'read', id, '--limit', '4', '--json'], { timeout: 3500, maxBuffer: 4 * 1024 * 1024 });
          const data = JSON.parse(stdout);
          const msgs = Array.isArray(data) ? data : (data?.messages || data?.items || []);
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            const role = m?.role || m?.type || '';
            if (role === 'assistant' || role === 'model') {
              const txt = cleanText(m.text || m.content || extractTextBlocks(m.parts), 240);
              if (txt) { lastReply = txt; break; }
            }
          }
          if (dshReplyCache.size >= 100) {
            dshReplyCache.delete(dshReplyCache.keys().next().value);
          }
          dshReplyCache.set(id, { asOfSeq: s.asOfSeq, lastReply });
        } catch {}
      }

      const cwdStr = typeof s.cwd === 'string' ? s.cwd : '';
      items.push({
        id,
        title: cleanText(s.title, 64) || `DSH ${id.slice(0, 12)}`,
        project: projectFromCwd(cwdStr, 'DSH'),
        running: Boolean(s.running),
        waiting: false,
        updatedAt: Math.round((Number(s.updatedAt) || Date.now()) / 1000),
        lastReply: lastReply || (s.running ? '正在执行中…' : '点击可复制续写命令'),
        continueCmd: `node ~/.agents/skills/dsh-session-bridge/scripts/dsh-session.mjs send ${shQuote(id)} "继续"`,
      });
    } catch {}
  }
  return items;
}

function collectUsageHistory() {
  const fp = path.join(HOME, '.config/howmanyusage/usage-history.json');
  if (!fs.existsSync(fp)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!Array.isArray(parsed?.days)) return null;
    // Keep only compact numeric fields needed for SummaryCharts
    return {
      days: parsed.days.map((d) => ({
        date: Number(d.date || 0),
        codex: Number(d.codex || 0),
        claude: Number(d.claude || 0),
        deepseek: Number(d.deepseek || 0),
        antigravity: Number(d.antigravity || 0),
        prompts: Number(d.prompts || 0),
        observed: Boolean(d.observed),
      })),
    };
  } catch {
    return null;
  }
}

function collectHowManyState() {
  const fp = path.join(HOME, '.config/howmanyusage/state.json');
  if (!fs.existsSync(fp)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const pc = parsed?.providerCache || {};
    const readQuota = (key) => {
      const p = pc[key]?.provider || pc[key];
      if (!p) return null;
      const fiveHour = p.fiveHour && typeof p.fiveHour.usedPercent === 'number'
        ? { usedPercent: p.fiveHour.usedPercent, resetAt: Number(p.fiveHour.resetAt || 0) }
        : null;
      const weekly = p.weekly && typeof p.weekly.usedPercent === 'number'
        ? { usedPercent: p.weekly.usedPercent, resetAt: Number(p.weekly.resetAt || 0) }
        : null;
      const balance = p.balance && typeof p.balance.total === 'number'
        ? { total: p.balance.total, currency: p.balance.currency || '' }
        : null;
      return { fiveHour, weekly, balance };
    };
    const colab = readQuota('colab');
    return {
      agy: readQuota('antigravity'),
      claude: readQuota('claude'),
      codex: readQuota('codex'),
      dsh: readQuota('deepseek'),
      colabCu: colab?.balance?.total ?? null,
    };
  } catch {
    return null;
  }
}

let lastSnapshot = { claude: [], codex: [], dsh: [], usageHistory: null, quotas: null, collectedAt: 0 };
let collecting = false;

export async function getExternalAgentsSnapshot(minIntervalMs = 6000) {
  const now = Date.now();
  if (collecting || (now - lastSnapshot.collectedAt < minIntervalMs && lastSnapshot.collectedAt > 0)) {
    return lastSnapshot;
  }
  collecting = true;
  try {
    const names = ['claude', 'codex', 'dsh', 'usageHistory', 'quotas'];
    const settled = await Promise.allSettled([
      Promise.resolve().then(collectClaude),
      Promise.resolve().then(collectCodex),
      collectDsh(),
      Promise.resolve().then(collectUsageHistory),
      Promise.resolve().then(collectHowManyState),
    ]);
    const next = { ...lastSnapshot, collectedAt: Date.now() };
    settled.forEach((res, idx) => {
      if (res.status === 'fulfilled') {
        next[names[idx]] = res.value;
      } else {
        console.error(`[office-collector] ${names[idx]} failed: ${res.reason?.message || res.reason}`);
      }
    });
    lastSnapshot = next;
    return lastSnapshot;
  } catch (err) {
    console.error(`[office-collector] snapshot failed: ${err?.message || err}`);
    return lastSnapshot;
  } finally {
    collecting = false;
  }
}
