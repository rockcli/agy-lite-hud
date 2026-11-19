import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getExternalAgentsSnapshot } from './office-collector.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STYLE_PATH = path.join(__dirname, 'style.css');
const USAGE_PATH = path.join(__dirname, 'usage-core.js');
const RUNTIME_PATH = path.join(__dirname, 'runtime.js');
const COLLECTOR_PATH = path.join(__dirname, 'office-collector.mjs');
const SPEED_PATH = path.join(os.homedir(), '.config/howmanyusage/agy-speed.json');

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');
const REMOVE = args.has('--remove');

function getPort() {
  if (process.env.AG_CDP_PORT) return process.env.AG_CDP_PORT.trim();
  const portFile = path.join(os.homedir(), 'Library/Application Support/Antigravity/DevToolsActivePort');
  if (!fs.existsSync(portFile)) return null;
  const first = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0];
  return first || null;
}

function isAllowedTargetUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'https:' && u.hostname === '127.0.0.1' && !u.username && !u.password;
  } catch {
    return false;
  }
}

function buildInjectExpr() {
  const css = fs.readFileSync(STYLE_PATH, 'utf8');
  const usageJs = fs.readFileSync(USAGE_PATH, 'utf8');
  const runtimeJs = fs.readFileSync(RUNTIME_PATH, 'utf8');
  return `(() => {
    let st = document.getElementById('ag-lite-hud-style');
    if (!st) {
      st = document.createElement('style');
      st.id = 'ag-lite-hud-style';
      document.head.appendChild(st);
    }
    st.textContent = ${JSON.stringify(css)};
    ${usageJs}
    ${runtimeJs}
    return window.__agLiteHudReady === true ? 'ok' : 'not-ready';
  })()`;
}

const REMOVE_EXPR = `(() => {
  if (typeof window.__agLiteHudDestroy === 'function') {
    try { window.__agLiteHudDestroy(); } catch {}
  }
  const st = document.getElementById('ag-lite-hud-style');
  if (st) st.remove();
  document.querySelectorAll('.ag-lite-bottom-bar, .ag-lite-context-ring, .ag-lite-metrics, .ag-lite-studio, .ag-lite-office').forEach((n) => n.remove());
  document.querySelectorAll('.ag-lite-studio-host').forEach((n) => n.classList.remove('ag-lite-studio-host'));
  try { delete window.__agLiteExternalAgents; } catch {}
  try { delete window.__agCsUsageCore; } catch {}
  return 'removed';
})()`;

async function evalCdp(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('ws timeout'));
    }, 4000);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = (e) => {
      clearTimeout(t);
      try { ws.close(); } catch {}
      reject(e);
    };
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('eval timeout'));
    }, 5000);
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id === 1) {
        clearTimeout(t);
        try { ws.close(); } catch {}
        if (msg.error || msg.result?.exceptionDetails) {
          const desc = msg.error?.message || msg.result?.exceptionDetails?.exception?.description || msg.result?.exceptionDetails?.text || 'CDP eval error';
          reject(new Error(desc));
          return;
        }
        resolve(msg.result?.result?.value);
      }
    };
    ws.onerror = (e) => {
      clearTimeout(t);
      try { ws.close(); } catch {}
      reject(e);
    };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
}

let lastSig = '';
let lastSpeedJson = '';
let lastOfficeJson = '';
let cachedExpr = '';
let ticking = false;
const injectedTargets = new Map();
const officePushedTargets = new Map();

function mergeAndWriteSpeedSamples(incoming) {
  if (!Array.isArray(incoming) || incoming.length === 0) return;
  let existing = [];
  try {
    if (fs.existsSync(SPEED_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(SPEED_PATH, 'utf8'));
      if (Array.isArray(parsed?.samples)) existing = parsed.samples;
    }
  } catch {}
  const byId = new Map();
  for (const s of existing) {
    if (s && s.id) byId.set(s.id, s);
  }
  for (const s of incoming) {
    if (s && s.id) byId.set(s.id, s);
  }
  const merged = [...byId.values()]
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    .slice(0, 200);
  const out = JSON.stringify({ samples: merged }, null, 2) + '\n';
  if (out === lastSpeedJson) return;
  fs.mkdirSync(path.dirname(SPEED_PATH), { recursive: true, mode: 0o700 });
  const tmp = `${SPEED_PATH}.tmp`;
  fs.writeFileSync(tmp, out, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, SPEED_PATH);
  lastSpeedJson = out;
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const port = getPort();
    if (!port) return;
    let targets;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!res.ok) return;
      targets = await res.json();
    } catch {
      return;
    }
    if (!Array.isArray(targets)) return;
    const pages = targets.filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl && isAllowedTargetUrl(t.url));

    if (REMOVE) {
      for (const p of pages) {
        try { await evalCdp(p.webSocketDebuggerUrl, REMOVE_EXPR); } catch {}
      }
      return;
    }

    const activeIds = new Set(pages.map((p) => p.id));
    for (const id of injectedTargets.keys()) {
      if (!activeIds.has(id)) injectedTargets.delete(id);
    }
    for (const id of officePushedTargets.keys()) {
      if (!activeIds.has(id)) officePushedTargets.delete(id);
    }
    if (pages.length === 0) return;

    const sig = [STYLE_PATH, USAGE_PATH, RUNTIME_PATH, COLLECTOR_PATH]
      .map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } })
      .join(':');
    const changed = sig !== lastSig;
    if (changed || !cachedExpr) {
      lastSig = sig;
      cachedExpr = buildInjectExpr();
    }

    const officeSnap = await getExternalAgentsSnapshot(ONCE ? 0 : 8000);
    const { collectedAt: _ignoredTs, ...officePayload } = officeSnap || {};
    lastOfficeJson = JSON.stringify(officePayload);

    for (const p of pages) {
      try {
        const alive = await evalCdp(p.webSocketDebuggerUrl, `Boolean(document.getElementById('ag-lite-hud-style') && window.__agLiteHudReady === true && typeof window.__agLiteHudDestroy === 'function')`);
        if (!alive || changed || injectedTargets.get(p.id) !== sig) {
          const status = await evalCdp(p.webSocketDebuggerUrl, cachedExpr);
          if (status === 'ok') {
            injectedTargets.set(p.id, sig);
            officePushedTargets.delete(p.id);
            console.log(`[${new Date().toISOString()}] injected: ${p.title || p.id}`);
          } else {
            console.error(`[${new Date().toISOString()}] inject skipped (${status}): ${p.id}`);
            continue;
          }
        }
        if (officePushedTargets.get(p.id) !== lastOfficeJson) {
          await evalCdp(
            p.webSocketDebuggerUrl,
            `(() => { window.__agLiteExternalAgents = ${lastOfficeJson}; if (typeof window.__agLiteRefreshOffice === 'function') window.__agLiteRefreshOffice(); return 'ok'; })()`
          );
          officePushedTargets.set(p.id, lastOfficeJson);
        }
        const samples = await evalCdp(p.webSocketDebuggerUrl, `window.__agLiteSpeedSamples || null`);
        if (Array.isArray(samples) && samples.length) {
          mergeAndWriteSpeedSamples(samples);
        }
      } catch (err) {
        console.error(`[${new Date().toISOString()}] target error (${p.id}): ${err?.message || err}`);
      }
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] tick error: ${err?.message || err}`);
  } finally {
    ticking = false;
  }
}

await tick();
if (!ONCE && !REMOVE) {
  setInterval(tick, 2000);
}
