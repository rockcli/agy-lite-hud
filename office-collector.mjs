import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HOME = os.homedir();
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RUNNING_WINDOW_MS = 75 * 1000;
const ACTIVE_JOB_STATUSES = new Set(['preparing', 'starting', 'queued', 'pending', 'running']);

function safeMtimeMs(p) {
  if (!p) return 0;
  try {
    return Math.floor(fs.statSync(p).mtimeMs) || 0;
  } catch {
    return 0;
  }
}

function maxItemMs(items) {
  let max = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const ms = Number(it?.updatedAt || 0) * 1000;
    if (ms > max) max = ms;
  }
  return max;
}

function hasPositiveCount(map) {
  return Object.values(map || {}).some((n) => Number(n) > 0);
}

function startOfTodayMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function isJobActivelyRunning(job, targetAgent, mtimeMs, now = Date.now()) {
  if (!ACTIVE_JOB_STATUSES.has(String(job?.status || ''))) return false;
  if (targetAgent === 'dsh') {
    const dl = Number(job?.deadline || 0);
    return dl > 0 ? now < dl : (now - mtimeMs < 30 * 60 * 1000);
  }
  if ([job?.claudePid, job?.codexPid, job?.workerPid].some(isPidAlive)) return true;
  return (now - mtimeMs) < 90 * 1000;
}

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

function resolveDispatcher(job, targetAgent) {
  const tid = String(job?.ownerThreadId || job?.owner?.id || job?.nativeTask?.owner || '').trim();
  let from = null;
  if (tid) {
    if (tid.startsWith('session-')) from = 'dsh';
    else if (/^[0-9a-f-]{36}$/i.test(tid) && fs.existsSync(path.join(HOME, '.gemini/antigravity/brain', tid))) from = 'agy';
    else if (/^01[89a-f][0-9a-f]{5}-[0-9a-f]{4}-7[0-9a-f]{3}-/i.test(tid)) from = 'codex';
  }
  if (!from) {
    const paths = [job?.repo, job?.cwd, job?.contextDir, job?.target?.repo].filter((x) => typeof x === 'string');
    if (paths.some((p) => p.includes('/.gemini/antigravity/'))) from = 'agy';
    else if (paths.some((p) => p.includes('/.codex/worktrees/'))) from = 'codex';
  }
  if (!from) {
    const rawHost = String(job?.ownerHost || job?.owner?.host || job?.nativeTask?.host || '').trim().toLowerCase();
    if (rawHost === 'agy' || rawHost === 'antigravity' || rawHost === 'gemini') from = 'agy';
    else if (rawHost === 'codex') from = 'codex';
    else if (rawHost === 'dsh') from = 'dsh';
    else if (rawHost === 'claude') from = 'claude';
  }
  if (!from || from === targetAgent) return null;
  return from;
}

function collectDispatchContext() {
  const dispatches = { agy: {}, claude: {}, codex: {}, dsh: {}, opencode: {} };
  const bySessionId = new Map();
  const byJobId = new Map();
  const runningByCwd = new Map();
  const activeJobs = { claude: [], codex: [], dsh: [] };
  const dshOutboxLatestAt = new Map();
  const now = Date.now();
  const cutoff = now - MAX_AGE_MS;
  const todayStartMs = startOfTodayMs();

  const jobRoots = [
    { targetAgent: 'claude', stateDir: process.env.OPUS_REVIEW_STATE_DIR || path.join(HOME, '.codex/state/opus-review') },
    { targetAgent: 'codex', stateDir: process.env.CODEX_JOBS_STATE_DIR || path.join(HOME, '.agents/state/codex-jobs') },
    { targetAgent: 'dsh', stateDir: process.env.DSH_REVIEW_STATE_DIR || path.join(HOME, '.dsh/bridge-reviews') },
  ];

  for (const { targetAgent, stateDir } of jobRoots) {
    if (!stateDir || !fs.existsSync(stateDir)) continue;
    const candidates = [];
    const scanParent = (parentDir, hexOnly = false) => {
      if (!fs.existsSync(parentDir)) return;
      let ents;
      try { ents = fs.readdirSync(parentDir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        if (hexOnly && !/^[0-9a-f]{32}$/i.test(e.name)) continue;
        const jp = path.join(parentDir, e.name, 'job.json');
        try {
          const st = fs.statSync(jp);
          if (st.mtimeMs >= cutoff && st.size > 0) candidates.push({ jp, mtimeMs: st.mtimeMs });
        } catch {}
      }
    };
    scanParent(path.join(stateDir, 'jobs'), false);
    if (targetAgent === 'dsh') scanParent(stateDir, true);

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const c of candidates.slice(0, 40)) {
      try {
        const job = JSON.parse(fs.readFileSync(c.jp, 'utf8'));
        const from = resolveDispatcher(job, targetAgent);
        const sessionIds = [job.result?.threadId, job.sessionId, job.resumeSessionId]
          .filter((sid) => typeof sid === 'string' && sid);
        const active = isJobActivelyRunning(job, targetAgent, c.mtimeMs, now);
        const info = {
          from,
          jobId: String(job.jobId || ''),
          cwd: typeof job.cwd === 'string' ? job.cwd : '',
          status: String(job.status || ''),
          active,
        };
        if (info.jobId) byJobId.set(info.jobId, info);
        for (const sid of sessionIds) {
          bySessionId.set(sid, info);
        }
        if (info.cwd && active) {
          runningByCwd.set(`${targetAgent}:${info.cwd}`, info);
        }
        if (active) {
          activeJobs[targetAgent].push({
            jobId: info.jobId || path.basename(path.dirname(c.jp)),
            from,
            cwd: info.cwd,
            repo: typeof job.repo === 'string' ? job.repo : info.cwd,
            kind: String(job.kind || 'task'),
            updatedAt: Math.round(c.mtimeMs / 1000),
            sessionIds,
          });
        }
        const jobCreatedMs = Date.parse(job.createdAt || job.startedAt || '') || c.mtimeMs;
        if (info.status !== 'cancelled' && from && (jobCreatedMs >= todayStartMs || active)) {
          dispatches[targetAgent][from] = (dispatches[targetAgent][from] || 0) + 1;
        }
      } catch {}
    }
  }

  const outboxPath = path.join(HOME, '.agents/state/dsh-session-bridge/outbox.json');
  if (fs.existsSync(outboxPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(outboxPath, 'utf8'));
      for (const bucket of Object.values(parsed || {})) {
        if (!bucket || typeof bucket !== 'object') continue;
        for (const entry of Object.values(bucket)) {
          if (entry && typeof entry.sessionId === 'string' && typeof entry.at === 'number') {
            const prev = dshOutboxLatestAt.get(entry.sessionId) || 0;
            if (entry.at > prev) dshOutboxLatestAt.set(entry.sessionId, entry.at);
          }
        }
      }
    } catch {}
  }

  return { dispatches, bySessionId, byJobId, runningByCwd, activeJobs, dshOutboxLatestAt, todayStartMs };
}

function appendActiveJobFallbacks(targetAgent, items, ctx) {
  const list = ctx?.activeJobs?.[targetAgent];
  if (!Array.isArray(list) || !list.length) return;
  const fallbackName = targetAgent === 'claude' ? 'Claude' : targetAgent === 'codex' ? 'Codex' : 'DSH';
  for (const aj of list) {
    const matched = items.some((it) =>
      (aj.sessionIds && aj.sessionIds.includes(it.id))
      || (aj.jobId && it.jobId === aj.jobId)
      || (aj.cwd && it.cwd === aj.cwd && it.running)
    );
    if (matched) continue;
    items.push({
      id: `job:${aj.jobId}`,
      title: aj.kind === 'review' ? '外部代码/方案审查执行中' : '外部委派任务执行中',
      project: projectFromCwd(aj.repo || aj.cwd, fallbackName),
      running: true,
      waiting: false,
      delegated: true,
      delegatedBy: aj.from,
      isSubagent: false,
      subagentCount: 0,
      updatedAt: aj.updatedAt || Math.round(Date.now() / 1000),
      lastReply: '正在执行主控派发的任务…',
      continueCmd: '',
    });
  }
}

function selectRecentItems(items, limit = 12) {
  const rank = (it) => (it.running ? 2 : !it.delegated ? 1 : 0);
  return [...items]
    .sort((a, b) => (rank(b) - rank(a)) || ((b.updatedAt || 0) - (a.updatedAt || 0)))
    .slice(0, limit)
    .map(({ jobId: _jid, cwd: _cwd, ...rest }) => rest);
}

function collectClaude(ctx) {
  const dir = path.join(HOME, '.claude/projects');
  if (!fs.existsSync(dir)) {
    const fallbackItems = [];
    appendActiveJobFallbacks('claude', fallbackItems, ctx);
    return selectRecentItems(fallbackItems, 12);
  }
  const files = findRecentJsonl(dir, 3, 36);
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
      let entrypoint = '';
      let promptSource = '';
      let turnOrigin = '';
      let isSidechain = false;

      for (let i = lines.length - 1; i >= 0; i--) {
        let obj;
        try { obj = JSON.parse(lines[i]); } catch { continue; }
        if (!cwd && obj.cwd) cwd = obj.cwd;
        if (!entrypoint && obj.entrypoint) entrypoint = obj.entrypoint;
        if (!promptSource && obj.promptSource) promptSource = obj.promptSource;
        if (!turnOrigin && obj.turnOrigin) turnOrigin = obj.turnOrigin;
        if (!isSidechain && obj.isSidechain) isSidechain = true;
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

      if (!title || !entrypoint || !cwd) {
        const headLines = readHead(f.p, 16384).split('\n').filter(Boolean);
        for (const hl of headLines) {
          try {
            const o = JSON.parse(hl);
            if (!cwd && o.cwd) cwd = o.cwd;
            if (!entrypoint && o.entrypoint) entrypoint = o.entrypoint;
            if (!promptSource && o.promptSource) promptSource = o.promptSource;
            if (!turnOrigin && o.turnOrigin) turnOrigin = o.turnOrigin;
            if (!isSidechain && o.isSidechain) isSidechain = true;
            if (!title && o.type === 'user' && o.message?.content) {
              const t = cleanText(extractTextBlocks(o.message.content), 64);
              if (t) title = t;
            }
          } catch {}
        }
      }

      let subagentCount = 0;
      const subDir = path.join(path.dirname(f.p), id, 'subagents');
      if (fs.existsSync(subDir)) {
        try {
          for (const se of fs.readdirSync(subDir, { withFileTypes: true })) {
            if (!se.isFile() || !se.name.endsWith('.jsonl')) continue;
            const sst = fs.statSync(path.join(subDir, se.name));
            if (now - sst.mtimeMs < RUNNING_WINDOW_MS) subagentCount++;
          }
        } catch {}
      }

      const prelimRunning = ((now - f.mtimeMs) < RUNNING_WINDOW_MS || subagentCount > 0) && !ended;
      const jobMatch = cwd.match(/\/opus-review\/jobs\/([0-9a-f]{32})/i);
      const matchedJob = ctx?.bySessionId?.get(id)
        || (jobMatch ? ctx?.byJobId?.get(jobMatch[1]) : null)
        || (cwd ? ctx?.runningByCwd?.get(`claude:${cwd}`) : null)
        || null;
      const running = Boolean(matchedJob?.active) || prelimRunning;
      const delegated = Boolean(
        matchedJob
        || entrypoint === 'sdk-cli'
        || promptSource === 'sdk'
        || turnOrigin === 'sdk'
        || isSidechain
        || cwd.includes('/opus-review/jobs/')
      );
      const delegatedBy = matchedJob?.from || (delegated && cwd.includes('/.gemini/antigravity/') ? 'agy' : null);
      if (!matchedJob && delegatedBy && ctx?.dispatches?.claude && (f.mtimeMs >= ctx.todayStartMs || running)) {
        ctx.dispatches.claude[delegatedBy] = (ctx.dispatches.claude[delegatedBy] || 0) + 1;
      } else if (!delegated && ctx?.dispatches?.claude && (f.mtimeMs >= ctx.todayStartMs || running)) {
        ctx.dispatches.claude.user = (ctx.dispatches.claude.user || 0) + 1;
      }

      const project = projectFromCwd(cwd, 'Claude');
      const continueCmd = cwd
        ? `cd -- ${shQuote(cwd)} && claude --resume ${shQuote(id)}`
        : `claude --resume ${shQuote(id)}`;

      items.push({
        id,
        jobId: matchedJob?.jobId || '',
        cwd,
        title: title || `Claude 会话 ${id.slice(0, 8)}`,
        project,
        running,
        waiting: false,
        delegated,
        delegatedBy,
        isSubagent: false,
        subagentCount,
        updatedAt: Math.round(f.mtimeMs / 1000),
        lastReply: lastReply || (running ? '正在执行中…' : '暂无文字回复摘要'),
        continueCmd,
      });
    } catch {}
  }
  appendActiveJobFallbacks('claude', items, ctx);
  return selectRecentItems(items, 12);
}

function collectCodex(ctx) {
  const sessionsRoot = path.join(HOME, '.codex/sessions');
  if (!fs.existsSync(sessionsRoot)) {
    const fallbackItems = [];
    appendActiveJobFallbacks('codex', fallbackItems, ctx);
    return selectRecentItems(fallbackItems, 12);
  }

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
  for (const f of files.slice(0, 36)) {
    try {
      const headLines = readHead(f.p, 131072).split('\n').filter(Boolean);
      let id = '';
      let cwd = '';
      let title = '';
      let originator = '';
      let source = null;
      for (const hl of headLines) {
        try {
          const o = JSON.parse(hl);
          if (o.type === 'session_meta' && o.payload) {
            if (o.payload.id) id = o.payload.id;
            if (o.payload.cwd) cwd = o.payload.cwd;
            if (o.payload.originator) originator = String(o.payload.originator);
            if (o.payload.source !== undefined) source = o.payload.source;
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

      const prelimRunning = (now - f.mtimeMs) < RUNNING_WINDOW_MS && !ended;
      const isSubagent = Boolean(source && typeof source === 'object' && source.subagent);
      const jobMatch = cwd.match(/\/codex-jobs\/jobs\/([0-9a-f]{32})/i);
      const matchedJob = ctx?.bySessionId?.get(id)
        || (jobMatch ? ctx?.byJobId?.get(jobMatch[1]) : null)
        || (cwd ? ctx?.runningByCwd?.get(`codex:${cwd}`) : null)
        || null;
      const running = Boolean(matchedJob?.active) || prelimRunning;
      const delegated = Boolean(
        matchedJob
        || isSubagent
        || originator === 'codex_exec'
        || source === 'exec'
        || cwd.includes('/codex-jobs/jobs/')
      );
      const delegatedBy = matchedJob?.from || (!isSubagent && delegated && cwd.includes('/.gemini/antigravity/') ? 'agy' : null);
      if (!matchedJob && delegatedBy && ctx?.dispatches?.codex && (f.mtimeMs >= ctx.todayStartMs || running)) {
        ctx.dispatches.codex[delegatedBy] = (ctx.dispatches.codex[delegatedBy] || 0) + 1;
      } else if (!delegated && !isSubagent && ctx?.dispatches?.codex && (f.mtimeMs >= ctx.todayStartMs || running)) {
        ctx.dispatches.codex.user = (ctx.dispatches.codex.user || 0) + 1;
      }

      const project = projectFromCwd(cwd, 'Codex');
      items.push({
        id,
        jobId: matchedJob?.jobId || '',
        cwd,
        title: title || `Codex 线程 ${id.slice(0, 8)}`,
        project,
        running,
        waiting: false,
        delegated,
        delegatedBy,
        isSubagent,
        subagentCount: 0,
        updatedAt: Math.round(f.mtimeMs / 1000),
        lastReply: lastReply || (running ? '正在执行中…' : '暂无文字回复摘要'),
        continueCmd: `codex resume ${shQuote(id)}`,
      });
    } catch {}
  }
  appendActiveJobFallbacks('codex', items, ctx);
  return selectRecentItems(items, 12);
}

async function collectDsh(ctx) {
  const script = path.join(HOME, '.agents/skills/dsh-session-bridge/scripts/dsh-session.mjs');
  if (!fs.existsSync(script)) {
    const fallbackItems = [];
    appendActiveJobFallbacks('dsh', fallbackItems, ctx);
    return selectRecentItems(fallbackItems, 12);
  }
  let rawList;
  try {
    const { stdout } = await execFileAsync(process.execPath, [script, 'list', '--limit', '18', '--json'], { timeout: 3500, maxBuffer: 4 * 1024 * 1024 });
    rawList = JSON.parse(stdout);
  } catch {
    const fallbackItems = [];
    appendActiveJobFallbacks('dsh', fallbackItems, ctx);
    return selectRecentItems(fallbackItems, 12);
  }
  if (!Array.isArray(rawList)) {
    const fallbackItems = [];
    appendActiveJobFallbacks('dsh', fallbackItems, ctx);
    return selectRecentItems(fallbackItems, 12);
  }

  const cutoff = Date.now() - MAX_AGE_MS;
  const recent = rawList.filter((s) => s && !s.archived && !s.blank && (s.running || (s.updatedAt || 0) >= cutoff));
  const preliminary = [];

  for (const s of recent) {
    try {
      const id = String(s.sessionId || '').trim();
      if (!id) continue;
      const cwdStr = typeof s.cwd === 'string' ? s.cwd : '';
      const title = cleanText(s.title, 64) || `DSH ${id.slice(0, 12)}`;
      const updatedMs = Number(s.updatedAt) || Date.now();
      const jobMatch = cwdStr.match(/\/bridge-reviews\/(?:jobs\/)?([0-9a-f]{32})/i);
      const matchedJob = ctx?.bySessionId?.get(id)
        || (jobMatch ? ctx?.byJobId?.get(jobMatch[1]) : null)
        || (cwdStr ? ctx?.runningByCwd?.get(`dsh:${cwdStr}`) : null)
        || null;
      const running = Boolean(s.running) || Boolean(matchedJob?.active);
      const outboxAt = ctx?.dshOutboxLatestAt?.get(id) || 0;
      const byOutbox = outboxAt > 0 && updatedMs >= outboxAt - 10000 && updatedMs <= outboxAt + 2 * 3600 * 1000;
      const delegated = Boolean(
        matchedJob
        || cwdStr.includes('/bridge-reviews/')
        || /^后台(审查|调查|任务)\b/.test(title)
        || s.visible === false
        || byOutbox
      );
      const delegatedBy = matchedJob?.from || null;
      if (!delegated && ctx?.dispatches?.dsh && (updatedMs >= ctx.todayStartMs || running)) {
        ctx.dispatches.dsh.user = (ctx.dispatches.dsh.user || 0) + 1;
      }

      preliminary.push({
        id,
        jobId: matchedJob?.jobId || '',
        cwd: cwdStr,
        asOfSeq: s.asOfSeq,
        title,
        project: projectFromCwd(cwdStr, 'DSH'),
        running,
        waiting: false,
        delegated,
        delegatedBy,
        isSubagent: false,
        subagentCount: 0,
        updatedAt: Math.round(updatedMs / 1000),
        lastReply: '',
        continueCmd: `node ~/.agents/skills/dsh-session-bridge/scripts/dsh-session.mjs send ${shQuote(id)} "继续"`,
      });
    } catch {}
  }

  appendActiveJobFallbacks('dsh', preliminary, ctx);
  const selected = selectRecentItems(preliminary, 12);
  let fetchCount = 0;
  for (const item of selected) {
    let lastReply = '';
    const asOfSeq = item.asOfSeq;
    delete item.asOfSeq;
    if (String(item.id).startsWith('job:')) continue;
    const cached = dshReplyCache.get(item.id);
    if (cached && cached.asOfSeq === asOfSeq) {
      lastReply = cached.lastReply;
    } else if ((item.running || !item.delegated) && fetchCount < 5) {
      fetchCount++;
      try {
        const { stdout } = await execFileAsync(process.execPath, [script, 'read', item.id, '--limit', '4', '--json'], { timeout: 3500, maxBuffer: 4 * 1024 * 1024 });
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
        dshReplyCache.set(item.id, { asOfSeq, lastReply });
      } catch {}
    }
    item.lastReply = lastReply || (item.running ? '正在执行中…' : '点击可复制续写命令');
  }
  return selected;
}

function resolveOpenCodeDataDir() {
  if (process.env.OPENCODE_DATA) return process.env.OPENCODE_DATA;
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, 'opencode');
  return path.join(HOME, '.local/share/opencode');
}

function getOpenCodePaths() {
  const dataDir = resolveOpenCodeDataDir();
  return {
    dataDir,
    dbPath: path.join(dataDir, 'opencode.db'),
    walPath: path.join(dataDir, 'opencode.db-wal'),
    legacySessionDir: path.join(dataDir, 'storage/session'),
  };
}

async function runSqliteJson(dbPath, sql) {
  try {
    const { stdout } = await execFileAsync(
      'sqlite3',
      ['-readonly', '-cmd', '.timeout 1000', '-json', dbPath, sql],
      { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }
    );
    if (!stdout || !stdout.trim()) return [];
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractOpenCodeContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text) {
      parts.push(b.text);
    }
  }
  return parts.join(' ');
}

function findRecentJsonFiles(rootDir, maxDepth = 2, limit = 24) {
  const cutoff = Date.now() - MAX_AGE_MS;
  const found = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.json')) {
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

async function collectOpenCode(ctx) {
  const { dbPath, legacySessionDir } = getOpenCodePaths();
  const now = Date.now();
  const cutoffMs = Math.floor(now - MAX_AGE_MS);
  const items = [];

  if (fs.existsSync(dbPath)) {
    const tables = await runSqliteJson(
      dbPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_v2','session','session_message','message','part')"
    );
    const tableNames = new Set(tables.map((t) => String(t?.name || '')).filter(Boolean));

    // Path A: OpenCode v2 (session_v2 + session_message)
    if (tableNames.has('session_v2')) {
      const rows = await runSqliteJson(
        dbPath,
        `SELECT id, parent_id, directory, title, time_created, time_updated, time_idle, idle_outcome FROM session_v2 WHERE time_archived IS NULL AND time_updated >= ${cutoffMs} ORDER BY time_updated DESC LIMIT 36`
      );
      if (rows.length > 0) {
        const latestMsgBySession = new Map();
        const replyBySession = new Map();
        if (tableNames.has('session_message')) {
          const msgs = await runSqliteJson(
            dbPath,
            `SELECT session_id, seq, data FROM session_message WHERE type = 'assistant' AND time_updated >= ${cutoffMs} ORDER BY seq DESC LIMIT 200`
          );
          for (const m of msgs) {
            const sid = String(m?.session_id || '');
            if (!sid) continue;
            let dataObj = null;
            try { dataObj = typeof m.data === 'string' ? JSON.parse(m.data) : m.data; } catch {}
            if (!latestMsgBySession.has(sid) && dataObj) {
              latestMsgBySession.set(sid, dataObj);
            }
            if (!replyBySession.has(sid) && dataObj) {
              const txt = cleanText(extractOpenCodeContentText(dataObj.content), 240);
              if (txt) replyBySession.set(sid, txt);
            }
          }
        }
        for (const row of rows) {
          const id = String(row?.id || '').trim();
          if (!id) continue;
          const updatedMs = Number(row.time_updated || row.time_created || 0);
          const timeIdle = Number(row.time_idle || 0);
          const isRecent = (now - updatedMs) < RUNNING_WINDOW_MS;
          const idleAfterUpdate = timeIdle > 0 && timeIdle >= updatedMs - 500;
          const latestAssistant = latestMsgBySession.get(id);
          const assistantCompleted = Boolean(latestAssistant?.time?.completed);
          const running = isRecent && !idleAfterUpdate && !assistantCompleted;
          const isSubagent = Boolean(row.parent_id);
          const cwd = typeof row.directory === 'string' ? row.directory : '';
          const title = cleanText(row.title, 64) || `OpenCode 会话 ${id.slice(0, 10)}`;
          const project = projectFromCwd(cwd, 'OpenCode');
          const lastReply = replyBySession.get(id) || '';
          const continueCmd = cwd
            ? `cd -- ${shQuote(cwd)} && opencode --session ${shQuote(id)}`
            : `opencode --session ${shQuote(id)}`;

          if (!isSubagent && ctx?.dispatches?.opencode && (updatedMs >= ctx.todayStartMs || running)) {
            ctx.dispatches.opencode.user = (ctx.dispatches.opencode.user || 0) + 1;
          }
          items.push({
            id,
            jobId: '',
            cwd,
            title,
            project,
            running,
            waiting: false,
            delegated: false,
            delegatedBy: null,
            isSubagent,
            subagentCount: 0,
            updatedAt: Math.round(updatedMs / 1000),
            lastReply: lastReply || (running ? '正在执行中…' : '暂无文字回复摘要'),
            continueCmd,
          });
        }
      }
    }

    // Path B: OpenCode v1 (session + message + part)
    if (items.length === 0 && tableNames.has('session')) {
      const rows = await runSqliteJson(
        dbPath,
        `SELECT id, parent_id, directory, title, time_created, time_updated FROM session WHERE time_archived IS NULL AND time_updated >= ${cutoffMs} ORDER BY time_updated DESC LIMIT 36`
      );
      if (rows.length > 0) {
        const latestCompletedBySession = new Map();
        const replyBySession = new Map();
        if (tableNames.has('message') && tableNames.has('part')) {
          const msgs = await runSqliteJson(
            dbPath,
            `SELECT id, session_id, time_updated, data FROM message WHERE time_updated >= ${cutoffMs} ORDER BY time_created DESC LIMIT 200`
          );
          const parts = await runSqliteJson(
            dbPath,
            `SELECT message_id, session_id, data FROM part WHERE time_updated >= ${cutoffMs} ORDER BY time_created DESC LIMIT 300`
          );
          const textByMsgId = new Map();
          for (const p of parts) {
            const mid = String(p?.message_id || '');
            if (!mid) continue;
            let pData = null;
            try { pData = typeof p.data === 'string' ? JSON.parse(p.data) : p.data; } catch {}
            if (!pData || pData.type !== 'text' || !pData.text) continue;
            const prev = textByMsgId.get(mid);
            textByMsgId.set(mid, prev ? `${pData.text} ${prev}` : pData.text);
          }
          for (const m of msgs) {
            const sid = String(m?.session_id || '');
            const mid = String(m?.id || '');
            if (!sid) continue;
            let mData = null;
            try { mData = typeof m.data === 'string' ? JSON.parse(m.data) : m.data; } catch {}
            if (mData?.role === 'assistant') {
              if (!latestCompletedBySession.has(sid)) {
                latestCompletedBySession.set(sid, Boolean(mData.time?.completed));
              }
              if (!replyBySession.has(sid) && mid && textByMsgId.has(mid)) {
                const txt = cleanText(textByMsgId.get(mid), 240);
                if (txt) replyBySession.set(sid, txt);
              }
            }
          }
        }
        for (const row of rows) {
          const id = String(row?.id || '').trim();
          if (!id) continue;
          const updatedMs = Number(row.time_updated || row.time_created || 0);
          const isRecent = (now - updatedMs) < RUNNING_WINDOW_MS;
          const assistantCompleted = Boolean(latestCompletedBySession.get(id));
          const running = isRecent && !assistantCompleted;
          const isSubagent = Boolean(row.parent_id);
          const cwd = typeof row.directory === 'string' ? row.directory : '';
          const title = cleanText(row.title, 64) || `OpenCode 会话 ${id.slice(0, 10)}`;
          const project = projectFromCwd(cwd, 'OpenCode');
          const lastReply = replyBySession.get(id) || '';
          const continueCmd = cwd
            ? `cd -- ${shQuote(cwd)} && opencode --session ${shQuote(id)}`
            : `opencode --session ${shQuote(id)}`;

          if (!isSubagent && ctx?.dispatches?.opencode && (updatedMs >= ctx.todayStartMs || running)) {
            ctx.dispatches.opencode.user = (ctx.dispatches.opencode.user || 0) + 1;
          }
          items.push({
            id,
            jobId: '',
            cwd,
            title,
            project,
            running,
            waiting: false,
            delegated: false,
            delegatedBy: null,
            isSubagent,
            subagentCount: 0,
            updatedAt: Math.round(updatedMs / 1000),
            lastReply: lastReply || (running ? '正在执行中…' : '暂无文字回复摘要'),
            continueCmd,
          });
        }
      }
    }
  } else if (fs.existsSync(legacySessionDir)) {
    // Path C: Legacy JSON fallback (storage/session)
    const files = findRecentJsonFiles(legacySessionDir, 2, 24);
    for (const f of files) {
      try {
        const s = JSON.parse(fs.readFileSync(f.p, 'utf8'));
        const id = String(s?.id || path.basename(f.p, '.json')).trim();
        if (!id) continue;
        const updatedMs = Number(s?.time?.updated || s?.time?.created || f.mtimeMs);
        const running = (now - updatedMs) < RUNNING_WINDOW_MS;
        const isSubagent = Boolean(s?.parentID || s?.parentId);
        const cwd = typeof s?.directory === 'string' ? s.directory : '';
        const title = cleanText(s?.title, 64) || `OpenCode 会话 ${id.slice(0, 10)}`;
        const project = projectFromCwd(cwd, 'OpenCode');
        const continueCmd = cwd
          ? `cd -- ${shQuote(cwd)} && opencode --session ${shQuote(id)}`
          : `opencode --session ${shQuote(id)}`;

        if (!isSubagent && ctx?.dispatches?.opencode && (updatedMs >= ctx.todayStartMs || running)) {
          ctx.dispatches.opencode.user = (ctx.dispatches.opencode.user || 0) + 1;
        }
        items.push({
          id,
          jobId: '',
          cwd,
          title,
          project,
          running,
          waiting: false,
          delegated: false,
          delegatedBy: null,
          isSubagent,
          subagentCount: 0,
          updatedAt: Math.round(updatedMs / 1000),
          lastReply: running ? '正在执行中…' : '暂无文字回复摘要',
          continueCmd,
        });
      } catch {}
    }
  }

  return selectRecentItems(items, 12);
}

const EXTERNAL_PROVIDERS = [
  {
    key: 'claude',
    slot: 1,
    collect: (ctx) => collectClaude(ctx),
    detect: (ctx) => fs.existsSync(path.join(HOME, '.claude/projects')) || ctx.activeJobs.claude.length > 0,
    lastActiveMs: (items) => Math.max(safeMtimeMs(path.join(HOME, '.claude/projects')), maxItemMs(items)),
  },
  {
    key: 'codex',
    slot: 2,
    collect: (ctx) => collectCodex(ctx),
    detect: (ctx) => fs.existsSync(path.join(HOME, '.codex/sessions')) || ctx.activeJobs.codex.length > 0,
    lastActiveMs: (items) => Math.max(safeMtimeMs(path.join(HOME, '.codex/sessions')), maxItemMs(items)),
  },
  {
    key: 'opencode',
    slot: 3,
    collect: (ctx) => collectOpenCode(ctx),
    detect: () => {
      const { dbPath, legacySessionDir } = getOpenCodePaths();
      return fs.existsSync(dbPath) || fs.existsSync(legacySessionDir);
    },
    lastActiveMs: (items) => {
      const { dbPath, walPath, legacySessionDir } = getOpenCodePaths();
      return Math.max(safeMtimeMs(dbPath), safeMtimeMs(walPath), safeMtimeMs(legacySessionDir), maxItemMs(items));
    },
  },
  {
    key: 'dsh',
    slot: 3,
    collect: (ctx) => collectDsh(ctx),
    detect: (ctx) => fs.existsSync(path.join(HOME, '.agents/skills/dsh-session-bridge/scripts/dsh-session.mjs')) || ctx.activeJobs.dsh.length > 0,
    lastActiveMs: (items) => Math.max(
      safeMtimeMs(path.join(HOME, '.dsh/sessions')),
      safeMtimeMs(path.join(HOME, '.dsh/bridge-reviews')),
      maxItemMs(items),
    ),
  },
];

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

let lastSnapshot = {
  claude: [],
  codex: [],
  dsh: [],
  opencode: [],
  providers: {},
  slot3Preferred: '',
  dispatches: { agy: {}, claude: {}, codex: {}, dsh: {}, opencode: {} },
  usageHistory: null,
  quotas: null,
  collectedAt: 0,
};
let collecting = false;

export async function getExternalAgentsSnapshot(minIntervalMs = 6000) {
  const now = Date.now();
  if (collecting || (now - lastSnapshot.collectedAt < minIntervalMs && lastSnapshot.collectedAt > 0)) {
    return lastSnapshot;
  }
  collecting = true;
  try {
    const ctx = collectDispatchContext();
    const names = [...EXTERNAL_PROVIDERS.map((p) => p.key), 'usageHistory', 'quotas'];
    const settled = await Promise.allSettled([
      ...EXTERNAL_PROVIDERS.map((p) => Promise.resolve().then(() => p.collect(ctx))),
      Promise.resolve().then(collectUsageHistory),
      Promise.resolve().then(collectHowManyState),
    ]);
    const next = {
      ...lastSnapshot,
      dispatches: ctx.dispatches,
      slot3Preferred: String(process.env.AG_SLOT4_AGENT || '').trim().toLowerCase(),
      collectedAt: Date.now(),
    };
    settled.forEach((res, idx) => {
      if (res.status === 'fulfilled') {
        next[names[idx]] = res.value;
      } else {
        console.error(`[office-collector] ${names[idx]} failed: ${res.reason?.message || res.reason}`);
      }
    });
    const providers = {};
    for (const p of EXTERNAL_PROVIDERS) {
      providers[p.key] = {
        key: p.key,
        slot: p.slot,
        installed: Boolean(
          p.detect(ctx)
          || (Array.isArray(next[p.key]) && next[p.key].length > 0)
          || hasPositiveCount(ctx.dispatches[p.key])
        ),
        lastActiveMs: Number(p.lastActiveMs(next[p.key]) || 0),
      };
    }
    next.providers = providers;
    lastSnapshot = next;
    return lastSnapshot;
  } catch (err) {
    console.error(`[office-collector] snapshot failed: ${err?.message || err}`);
    return lastSnapshot;
  } finally {
    collecting = false;
  }
}
