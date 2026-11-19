(() => {
  'use strict';
  if (typeof window.__agLiteHudDestroy === 'function') {
    try { window.__agLiteHudDestroy(); } catch {}
  }

  const usageCore = window.__agCsUsageCore;
  if (!usageCore) return;

  let destroyed = false;
  let cachedSvc = null;
  let cachedStore = null;
  let cachedRouter = null;
  let storeUnsub = null;
  let storeDebounce = null;
  let pollTimer = null;
  let mutObs = null;
  let mutDebounce = null;
  let studioFilter = 'all';
  let selectedStation = null; // 'agy' | 'claude' | 'codex' | 'dsh' | 'rack' | 'board' | null
  let salutingStations = new Map(); // key -> phrase
  let saluteTimer = null;
  let lastStationMap = null;

  const trajCache = new Map();
  const knownModelMaxCtx = new Map();

  function ensureHooks(allowPartial = false) {
    if (cachedSvc && cachedStore && cachedRouter) return { svc: cachedSvc, store: cachedStore, router: cachedRouter };
    const anchors = document.querySelectorAll(
      '[data-testid="conversation-view"], [data-testid="agent-input-box"], [data-testid="conversation-row-sidebar"], [data-testid="new-conversation-button"]'
    );
    for (const el of anchors) {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      for (let f = key && el[key]; f && !(cachedSvc && cachedStore && cachedRouter); f = f.return) {
        const p = f.memoizedProps;
        if (!cachedStore && p && p.store && typeof p.store.getState === 'function') {
          cachedStore = p.store;
        }
        for (let d = f.dependencies && f.dependencies.firstContext; d; d = d.next) {
          const v = d.memoizedValue;
          if (!v || typeof v !== 'object') continue;
          if (!cachedSvc && typeof v.getCascadeTrajectory === 'function') cachedSvc = v;
          if (!cachedStore && v.store && typeof v.store.getState === 'function') cachedStore = v.store;
          if (!cachedRouter && typeof v.navigate === 'function' && v.history && v.routeTree) cachedRouter = v;
        }
      }
      if (cachedSvc && cachedStore && cachedRouter) break;
    }
    if (cachedStore && !storeUnsub) {
      storeUnsub = cachedStore.subscribe(() => {
        if (destroyed || storeDebounce) return;
        storeDebounce = setTimeout(() => {
          storeDebounce = null;
          if (!destroyed) syncAll();
        }, 400);
      });
    }
    if (cachedSvc && cachedStore) return { svc: cachedSvc, store: cachedStore, router: cachedRouter };
    if (allowPartial && (cachedSvc || cachedStore)) return { svc: cachedSvc, store: cachedStore, router: cachedRouter };
    return null;
  }

  function resolveCascadeId(inputBox) {
    const cv = inputBox
      ? inputBox.closest('[data-testid="conversation-view"]')
      : document.querySelector('[data-testid="conversation-view"]');
    if (cv) {
      const attrId = cv.getAttribute('data-cascade-id');
      if (attrId && attrId !== 'conversation') return attrId;
    }
    const m = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
    if (m) return m[1];
    const readFromFiber = (el, maxDepth) => {
      if (!el) return '';
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      for (let f = key && el[key], d = 0; f && d < maxDepth; f = f.return, d++) {
        const p = f.memoizedProps || f.pendingProps;
        if (p && typeof p.cascadeId === 'string' && p.cascadeId) return p.cascadeId;
      }
      return '';
    };
    return readFromFiber(inputBox, 60) || readFromFiber(cv, 35) || '';
  }

  function getModelLabel(card) {
    const btn = (card || document).querySelector('[data-testid="model-selector-trigger"]');
    return btn ? (btn.textContent || btn.getAttribute('aria-label') || '').trim() : '';
  }

  function getDraftTokens(card) {
    const editor = card?.querySelector('[contenteditable="true"], textarea');
    const txt = editor ? (editor.value !== undefined ? editor.value : editor.innerText || '') : '';
    const trimmed = txt.trim();
    return trimmed ? Math.ceil(trimmed.length / 4) : 0;
  }

  async function fetchActiveConvo(cascadeId) {
    if (!cascadeId) return null;
    const h = ensureHooks();
    if (!h) return null;
    const st = h.store.getState();
    const allSummaries = st.trajectorySummaries?.summaries || st.cascadeTrajectorySummaries || {};
    const sumEntry = allSummaries[cascadeId];
    const sum = sumEntry?.summary || sumEntry || {};
    const stepCount = Number(sum?.stepCount || 0);
    const lastMod = Number(sum?.lastModifiedTime?.seconds || 0);
    const running = !!(sum?.notFullyIdle || sum?.hasActivity || sum?.status === 2 || sum?.hasRunningSubagents);

    let entry = trajCache.get(cascadeId);
    if (!entry) {
      entry = { fetching: false, lastStep: -1, lastMod: -1, lastRunning: false, lastAt: 0, data: null };
      trajCache.set(cascadeId, entry);
    }
    if (entry.fetching) return entry.data;
    const now = Date.now();
    const minMs = running ? 1000 : !entry.data || entry.data.calls === 0 ? 1500 : 3500;
    const changed = !entry.data || entry.lastStep !== stepCount || entry.lastMod !== lastMod || entry.lastRunning !== running;
    if (!changed && entry.data.calls > 0 && !running && !entry.data.isRunning) return entry.data;
    if (!changed && now - entry.lastAt < minMs) return entry.data;

    entry.fetching = true;
    try {
      const res = await h.svc.getCascadeTrajectory({ cascadeId });
      const analyzed = usageCore.analyzeActiveConversation(res, { cascadeId });
      if (analyzed && analyzed.maxContextTokens > 0 && analyzed.hasActiveLimits && analyzed.lastModel) {
        knownModelMaxCtx.set(analyzed.lastModel.toLowerCase(), analyzed.maxContextTokens);
      }
      if (analyzed && Array.isArray(analyzed.callList)) {
        const steps = res?.trajectory?.steps || [];
        const samples = [];
        for (const c of analyzed.callList) {
          if (!(c.outputTokens > 0 && c.stream > 0)) continue;
          const stepIdx = Array.isArray(c.stepIndices) && c.stepIndices.length ? c.stepIndices[0] : c.callNumber;
          const meta = steps[stepIdx]?.metadata || {};
          const completedAt = Math.round(
            usageCore.tsSec(meta.finishedGeneratingAt || meta.completedAt || meta.createdAt) || Date.now() / 1000
          );
          samples.push({
            id: `${cascadeId}:${stepIdx}`,
            model: c.modelDisplayName || c.responseModel || '',
            outputTokens: Number(c.outputTokens || 0),
            ttft: Number(Number(c.ttft || 0).toFixed(3)),
            stream: Number(Number(c.stream || 0).toFixed(3)),
            completedAt,
          });
        }
        window.__agLiteSpeedSamples = samples;
      }
      entry.data = analyzed;
      entry.lastStep = stepCount;
      entry.lastMod = lastMod;
      entry.lastRunning = running;
      entry.lastAt = Date.now();
      return analyzed;
    } catch {
      return entry.data;
    } finally {
      entry.fetching = false;
    }
  }

  function renderWidgets(footer, card, data) {
    const label = getModelLabel(card).toLowerCase();
    const knownMax = (label && knownModelMaxCtx.get(label)) || Number(data?.maxContextTokens || 256000);
    const effectiveInfo = data && (data.calls > 0 || data.hasActiveLimits) ? data : { ...(data || {}), maxContextTokens: knownMax };
    const ring = usageCore.computeRingTelemetry({
      activeInfo: effectiveInfo,
      quotaInfo: null,
      draftTokens: getDraftTokens(card),
      ringMode: 'context',
      knownLimits: knownMax > 0 ? { maxContextTokens: knownMax } : null,
    });

    const pct = Math.max(0, Math.min(100, ring.pct));
    const r = 5.5;
    const circ = 2 * Math.PI * r;
    const dash = ((pct / 100) * circ).toFixed(2);
    const key = `${ring.pctRound}|${dash}|${ring.color}`;

    const plusBtn =
      footer?.querySelector('button[aria-label="Add context"]') ||
      footer?.querySelector('button[aria-haspopup="menu"]') ||
      footer?.querySelector('button');
    if (!plusBtn || !plusBtn.parentElement) return;

    let el = footer.querySelector('.ag-lite-context-ring');
    if (!el) {
      el = document.createElement('span');
      el.className = 'ag-lite-context-ring';
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="${r}" fill="none" stroke="rgba(128,128,128,0.22)" stroke-width="2.2"/><circle class="ag-lite-ring-fill" cx="8" cy="8" r="${r}" fill="none" stroke="${ring.color}" stroke-width="2.2" stroke-dasharray="${dash} ${circ.toFixed(2)}" stroke-linecap="round"/></svg>`;
      plusBtn.insertAdjacentElement('afterend', el);
    } else if (plusBtn.nextElementSibling !== el) {
      plusBtn.insertAdjacentElement('afterend', el);
    }
    if (el.getAttribute('data-ag-lite-key') !== key) {
      el.setAttribute('data-ag-lite-key', key);
      const fill = el.querySelector('.ag-lite-ring-fill');
      if (fill) {
        fill.setAttribute('stroke', ring.color);
        fill.setAttribute('stroke-dasharray', `${dash} ${circ.toFixed(2)}`);
      }
    }
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatRelTime(sec) {
    if (!sec || sec <= 0) return '';
    const diff = Math.max(0, Math.floor(Date.now() / 1000 - sec));
    if (diff < 45) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)}m 前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h 前`;
    return `${Math.floor(diff / 86400)}d 前`;
  }

  function getReadMarks() {
    try {
      return JSON.parse(localStorage.getItem('ag-lite-office-read') || '{}') || {};
    } catch {
      return {};
    }
  }

  function saveReadMarks(marks) {
    try { localStorage.setItem('ag-lite-office-read', JSON.stringify(marks)); } catch {}
  }

  function markExternalRead(agentKey, taskId, ts) {
    const marks = getReadMarks();
    if (!marks[agentKey]) marks[agentKey] = {};
    if (taskId === '_all') {
      marks[agentKey]._all = Math.floor(Date.now() / 1000) + 1;
    } else {
      marks[agentKey][taskId] = Math.max(Number(ts || 0), Math.floor(Date.now() / 1000)) + 1;
    }
    saveReadMarks(marks);
  }

  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).catch(() => {});
      return;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }

  function openConversation(cid) {
    if (!cid) return;
    const link = [...document.querySelectorAll('a[href]')].find((a) => (a.getAttribute('href') || '').includes(`/c/${cid}`));
    if (link) {
      link.click();
      return;
    }
    const h = ensureHooks(true);
    if (h?.router) {
      try {
        if (typeof h.router.navigate === 'function') {
          h.router.navigate({ to: `/c/${cid}` });
          return;
        }
        if (h.router.history && typeof h.router.history.push === 'function') {
          h.router.history.push(`/c/${cid}`);
          return;
        }
      } catch {}
    }
    window.history.pushState({}, '', `/c/${cid}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  function collectAgyItems(st) {
    const summaries = st?.trajectorySummaries?.summaries || {};
    const idx = st?.trajectorySummaries?.indexes || {};
    const localViewed = st?.conversation?.localLastViewedTimes || {};
    const projects = st?.sidebarProjects?.projects || {};

    const cidToProject = new Map();
    for (const [pid, cidMap] of Object.entries(idx.byProject || {})) {
      const pname = projects[pid]?.name || '';
      if (!pname || pid === 'default-cli-project') continue;
      for (const cid of Object.keys(cidMap || {})) cidToProject.set(cid, pname);
    }

    const archivedMap = idx.archived || {};
    const sidebarMap = idx.sidebar || {};
    const topLevelMap = idx.topLevel || {};
    const hasIndex = Object.keys(sidebarMap).length > 0 || Object.keys(topLevelMap).length > 0;

    const waiting = [];
    const running = [];
    const unread = [];
    const bgTasks = [];
    let subagentTotal = 0;

    for (const [cid, s] of Object.entries(summaries)) {
      if (!s || archivedMap[cid] || s.annotations?.archived || s.annotations?.deleted) continue;
      if (hasIndex && !sidebarMap[cid] && !topLevelMap[cid]) continue;
      const title = (s.annotations?.title || s.summary || '').trim();
      if (!title) continue;

      const subagentCount = Object.keys(idx.activeSubagentsByParent?.[cid] || {}).length || (s.hasRunningSubagents ? 1 : 0);
      const isWaiting = Boolean(idx.hasWaitingSteps?.[cid]) || (Array.isArray(s.waitingSteps) && s.waitingSteps.length > 0) || Boolean(s.interrupted);
      const isRunning = s.status === 2 || subagentCount > 0;
      const bgCount = Number(s.backgroundTaskCount || 0);
      const lastMod = Number(s.lastModifiedTime?.seconds || 0);
      const annView = Number(s.annotations?.lastUserViewTime?.seconds || 0);
      const locView = Number(localViewed[cid] || 0);
      const lastView = Math.max(annView, locView);
      const isUnread = Boolean(idx.serverUnread?.[cid]) || Boolean(s.annotations?.markedAsUnread) || (lastMod > 0 && lastView > 0 && lastMod > lastView + 5 && !isRunning && !isWaiting && bgCount === 0);

      if (!isWaiting && !isRunning && !isUnread && bgCount <= 0) continue;

      let project = cidToProject.get(cid) || '';
      if (!project) {
        const uri = (s.workspaces || []).map((w) => w.workspaceFolderAbsoluteUri || '').find(Boolean) || '';
        if (uri) project = decodeURIComponent(uri.replace(/\/+$/, '').split('/').pop() || '');
      }
      if (!project) project = '独立对话';

      const item = {
        id: cid,
        title,
        project,
        stepCount: Number(s.stepCount || 0),
        updatedAt: lastMod,
        bgCount,
        subagentCount,
      };
      subagentTotal += subagentCount;

      if (isWaiting) waiting.push(item);
      else if (isRunning) running.push(item);
      else if (isUnread) unread.push(item);
      else if (bgCount > 0) bgTasks.push(item);
    }

    const byTime = (a, b) => b.updatedAt - a.updatedAt;
    waiting.sort(byTime);
    running.sort(byTime);
    unread.sort(byTime);
    bgTasks.sort(byTime);
    return { waiting, running, unread, bgTasks, subagentTotal };
  }

  function buildExternalStation(agentKey, rawList, readMarks) {
    const wm = readMarks[agentKey] || {};
    const allCut = Number(wm._all || 0);
    const waiting = [];
    const running = [];
    const unread = [];
    for (const t of Array.isArray(rawList) ? rawList : []) {
      if (!t || !t.id) continue;
      if (t.waiting) {
        waiting.push(t);
      } else if (t.running) {
        running.push(t);
      } else {
        const itemCut = Math.max(allCut, Number(wm[t.id] || 0));
        if ((t.updatedAt || 0) > itemCut) {
          unread.push(t);
        }
      }
    }
    return { waiting, running, unread, subagentTotal: 0 };
  }

  const INTERNS = [
    { key: 'agy', name: 'Gemini', x: 255, y: 214, shirt: '#5b6ef5', hair: '#252834', accent: '#5b6ef5', deskTop: '#ffffff', deskSide: '#dce2ec' },
    { key: 'claude', name: 'Claude', x: 462, y: 204, shirt: '#d97757', hair: '#4a3228', accent: '#d97757', deskTop: '#ffffff', deskSide: '#dce2ec' },
    { key: 'codex', name: 'ChatGPT', x: 332, y: 326, shirt: '#10a37f', hair: '#1e242b', accent: '#10a37f', deskTop: '#ffffff', deskSide: '#dce2ec' },
    { key: 'dsh', name: 'DeepSeek', x: 590, y: 316, shirt: '#2563eb', hair: '#2c3040', accent: '#2563eb', deskTop: '#ffffff', deskSide: '#dce2ec' },
  ];

  function getStrikeInfo(quota) {
    if (!quota) return null;
    const h5 = Number(quota.fiveHour?.usedPercent ?? -1);
    const wk = Number(quota.weekly?.usedPercent ?? -1);
    if (h5 >= 95 || wk >= 95) {
      const reason = h5 >= 95 && wk >= 95
        ? `5h ${Math.round(h5)}% · 周 ${Math.round(wk)}%`
        : h5 >= 95
          ? `5h 额度 ${Math.round(h5)}%`
          : `周额度 ${Math.round(wk)}%`;
      const resetAt = h5 >= 95 ? (quota.fiveHour?.resetAt || 0) : (quota.weekly?.resetAt || 0);
      return { h5, wk, reason, resetAt };
    }
    return null;
  }

  function formatCu(cu) {
    if (typeof cu !== 'number' || !Number.isFinite(cu)) return '';
    return cu >= 1000 ? `${Math.round(cu).toLocaleString()} CU` : `${cu.toFixed(1)} CU`;
  }

  function getStaminaInfo(quota) {
    if (!quota) return null;
    if (quota.fiveHour || quota.weekly) {
      const h5 = Number(quota.fiveHour?.usedPercent ?? 0);
      const wk = Number(quota.weekly?.usedPercent ?? 0);
      const maxUsed = Math.max(h5, wk);
      const pct = Math.max(0, Math.min(100, Math.round(100 - maxUsed)));
      const color = pct > 40 ? '#10b981' : pct > 15 ? '#f59e0b' : '#ef4444';
      return {
        pct,
        color,
        tooltip: `剩余体力 ${pct}%（5h 已用 ${Math.round(h5)}% · 周已用 ${Math.round(wk)}%）`,
      };
    }
    if (quota.balance && typeof quota.balance.total === 'number') {
      const bal = quota.balance.total;
      const pct = bal <= 0 ? 0 : Math.min(100, Math.max(10, Math.round((bal / 200) * 100)));
      const color = bal > 20 ? '#0ea5e9' : bal > 5 ? '#f59e0b' : '#ef4444';
      return {
        pct,
        color,
        tooltip: `账户余额 ¥${bal.toFixed(2)}`,
      };
    }
    return null;
  }

  function fillNewConvoComposer(text) {
    const boxes = document.querySelectorAll('[data-testid="agent-input-box"]');
    let editor = null;
    for (const ib of boxes) {
      if (resolveCascadeId(ib)) continue;
      const ed = ib.querySelector('[contenteditable="true"], textarea');
      if (ed) { editor = ed; break; }
    }
    if (!editor) {
      editor = document.querySelector('[data-testid="agent-input-box"] [contenteditable="true"], [data-testid="agent-input-box"] textarea');
    }
    if (!editor) return false;

    editor.focus();
    if (editor.tagName === 'TEXTAREA') {
      editor.value = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    // Lexical / contenteditable: try paste event first (most reliable with Lexical state), fallback to execCommand
    try {
      document.execCommand('selectAll', false, null);
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const pasteEv = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      editor.dispatchEvent(pasteEv);
      if ((editor.innerText || '').trim().length < 5) {
        document.execCommand('insertText', false, text);
      }
    } catch {
      try { document.execCommand('insertText', false, text); } catch {}
    }
    editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  }

  function getVendorLogoInner(key, uid = '0') {
    // Clean, high-precision vector paths in 24x24 viewBox (smooth anti-aliased)
    if (key === 'agy') {
      const gid = `ag-logo-gem-${uid}`;
      return `<defs>
        <linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#4285F4"/>
          <stop offset="45%" stop-color="#6366F1"/>
          <stop offset="78%" stop-color="#EC4899"/>
          <stop offset="100%" stop-color="#F59E0B"/>
        </linearGradient>
      </defs>
      <path d="M12 1.8C13 7.4 16.6 11 22.2 12C16.6 13 13 16.6 12 22.2C11 16.6 7.4 13 1.8 12C7.4 11 11 7.4 12 1.8Z" fill="url(#${gid})"/>`;
    }
    if (key === 'claude') {
      // Single clean Anthropic / Claude 12-spoke starburst (no self-intersection)
      const spokes = [];
      for (let i = 0; i < 12; i++) {
        const deg = i * 30;
        const len = i % 2 === 0 ? 8.6 : 6.6;
        spokes.push(`<line x1="0" y1="0" x2="0" y2="${-len}" transform="rotate(${deg})"/>`);
      }
      return `<g transform="translate(12, 12)" stroke="#D97757" stroke-width="2.1" stroke-linecap="round">${spokes.join('')}<circle cx="0" cy="0" r="2.2" fill="#D97757" stroke="none"/></g>`;
    }
    if (key === 'codex') {
      // OpenAI official interlocking 6-petal blossom knot
      return `<path fill="#10A37F" d="M22.28 9.82a5.98 5.98 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.98 5.98 0 0 0-4 2.9 6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.51 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07zM13.26 22.43a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.8.8 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.05v5.58a4.5 4.5 0 0 1-4.49 4.5zm-9.66-4.13a4.47 4.47 0 0 1-.53-3.01l.14.09 4.78 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.06l-4.84 2.79a4.5 4.5 0 0 1-6.14-1.65zM2.34 7.9a4.49 4.49 0 0 1 2.37-1.97V11.6a.77.77 0 0 0 .39.68l5.81 3.35-2.02 1.17a.08.08 0 0 1-.07 0l-4.83-2.79A4.5 4.5 0 0 1 2.34 7.9zm16.6 3.86L13.1 8.36l2.02-1.16a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.68a.79.79 0 0 0-.4-.65zm2.01-3.02-.14-.09-4.77-2.78a.78.78 0 0 0-.79 0L9.41 9.23V6.9a.07.07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66zM8.31 12.86l-2.02-1.16a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-.14.08L8.7 5.46a.8.8 0 0 0-.39.68zm1.1-2.37 2.6-1.5 2.6 1.5v3l-2.6 1.5-2.6-1.5z"/>`;
    }
    // DeepSeek iconic whale silhouette
    return `<path fill="#4D6BFE" d="M21.4 10.6c-.7-3.4-3.7-5.8-7.4-5.8-3.1 0-5.8 1.8-7 4.4-.5 1.1-1.3 1.7-2.4 1.5-.8-.1-1.5-.7-2.1-1.6-.2-.3-.6-.1-.6.3-.1 1.7.5 3.1 1.6 4.1-.7.7-1.1 1.5-1.2 2.4 0 .4.4.6.7.4 1.1-.7 2.1-1 3.1-.9 1.6 2.1 4.3 3.4 7.4 3.4 4.7 0 8.3-3.2 8.3-7.3 0-.3 0-.6-.4-.9z"/><circle cx="16.4" cy="10.8" r="1.25" fill="#ffffff"/><path d="M13.5 14.2c1.2.8 3 .8 4.2 0" fill="none" stroke="#ffffff" stroke-width="1.2" stroke-linecap="round"/>`;
  }

  function renderVendorBadgeHtml(key, uid = 'lbl') {
    return `<span class="ag-office-logo-sm"><svg viewBox="0 0 24 24" aria-hidden="true">${getVendorLogoInner(key, uid)}</svg></span>`;
  }

  function renderVendorLogo(key) {
    // Harmonious pixel-style chest emblem directly on the hoodie
    if (key === 'agy') {
      return `<g transform="translate(14, -10)">
        <path d="M0,-5 C0.6,-1.5 1.5,-0.6 5,0 C1.5,0.6 0.6,1.5 0,5 C-0.6,1.5 -1.5,0.6 -5,0 C-1.5,-0.6 -0.6,-1.5 0,-5 Z" fill="#ffffff"/>
        <circle cx="3.6" cy="-3.4" r="1" fill="#fde047"/>
      </g>`;
    }
    if (key === 'claude') {
      return `<g transform="translate(14, -10)" stroke="#fff7ed" stroke-width="1.4" stroke-linecap="round">
        <line x1="0" y1="-4.8" x2="0" y2="4.8"/>
        <line x1="-4.8" y1="0" x2="4.8" y2="0"/>
        <line x1="-3.4" y1="-3.4" x2="3.4" y2="3.4"/>
        <line x1="3.4" y1="-3.4" x2="-3.4" y2="3.4"/>
        <circle cx="0" cy="0" r="1.2" fill="#fff7ed" stroke="none"/>
      </g>`;
    }
    if (key === 'codex') {
      return `<g transform="translate(14, -10)" fill="none" stroke="#ffffff" stroke-width="1.25" stroke-linejoin="round">
        <polygon points="0,-4.8 4.2,-2.4 4.2,2.4 0,4.8 -4.2,2.4 -4.2,-2.4"/>
        <circle cx="0" cy="0" r="1.7"/>
        <line x1="0" y1="-4.8" x2="0" y2="-1.7"/>
        <line x1="4.2" y1="2.4" x2="1.4" y2="0.8"/>
        <line x1="-4.2" y1="2.4" x2="-1.4" y2="0.8"/>
      </g>`;
    }
    return `<g transform="translate(14, -10)">
      <path d="M-4.6,0.9 C-4.6,-2.7 -1.4,-4.2 1.9,-3.2 C3.9,-2.6 4.8,-0.7 4.4,1.4 C4.1,3.2 1.4,3.7 -1.4,3.3 C-3,3.1 -4.2,2.2 -4.6,0.9 Z" fill="#ffffff"/>
      <path d="M-4.3,0.7 L-6.7,-1.5 L-5.7,1.5 L-6.9,3 Z" fill="#ffffff"/>
      <circle cx="2" cy="-0.5" r="0.8" fill="#1d4ed8"/>
    </g>`;
  }

  function compactNum(v) {
    if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    return String(Math.round(v));
  }

  function activityLevel(prompts) {
    if (prompts < 1) return 0;
    if (prompts < 10) return 1;
    if (prompts < 30) return 2;
    if (prompts < 80) return 3;
    if (prompts < 160) return 4;
    if (prompts < 300) return 5;
    return 6;
  }

  const ACTIVITY_LIGHT = ['#e0f0e3', '#b5e8bf', '#7ad99c', '#3bc46e', '#129954', '#08703b', '#034a1f'];
  const ACTIVITY_DARK = ['#33453b', '#a6dbb0', '#70c98c', '#3dba6e', '#1aa859', '#128242', '#085c30'];

  function formatSwiftDate(appleSec) {
    if (!appleSec) return '';
    const d = new Date((Number(appleSec) + 978307200 + 8 * 3600) * 1000);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }

  function swiftWeekdayOffset(appleSec) {
    // 0 = Mon .. 6 = Sun in UTC+8 (matches UsagePopoverView.swift)
    const d = new Date((Number(appleSec) + 978307200 + 8 * 3600) * 1000);
    return (d.getUTCDay() + 6) % 7;
  }

  function computeBoardStats(usageHistory) {
    const days = Array.isArray(usageHistory?.days) ? usageHistory.days : [];
    const recent = days.slice(-7);
    const sums = { agy: 0, claude: 0, codex: 0, dsh: 0 };
    let weekPrompts = 0;
    let observedDays = 0;
    for (const d of recent) {
      sums.codex += Number(d.codex || 0);
      sums.claude += Number(d.claude || 0);
      sums.dsh += Number(d.deepseek || 0);
      sums.agy += Number(d.antigravity || 0);
      if (d.observed) {
        weekPrompts += Number(d.prompts || 0);
        observedDays++;
      }
    }
    const today = days[days.length - 1] || null;
    const todayPrompts = Number(today?.prompts || 0);
    const todayTokens = today
      ? Number(today.codex || 0) + Number(today.claude || 0) + Number(today.deepseek || 0) + Number(today.antigravity || 0)
      : 0;
    const avgPrompts = observedDays > 0 ? Math.max(1, Math.round(weekPrompts / observedDays)) : 50;
    const meta = {
      agy: { name: 'Gemini', full: 'Gemini', color: '#7c3aed' },
      claude: { name: 'Claude', full: 'Claude', color: '#d97757' },
      codex: { name: 'ChatGPT', full: 'ChatGPT', color: '#10a37f' },
      dsh: { name: 'DeepSeek', full: 'DeepSeek', color: '#2563eb' },
    };
    const ranking = Object.entries(sums)
      .map(([key, tokens]) => ({ key, tokens, ...meta[key] }))
      .sort((a, b) => b.tokens - a.tokens);
    const champion = ranking[0] && ranking[0].tokens > 0 ? ranking[0] : null;
    return { sums, ranking, champion, weekPrompts, avgPrompts, todayPrompts, todayTokens };
  }

  function drawSalesBoardSvg(usageHistory, isDark, box) {
    const { x, y, w, h, compact } = box;
    const stats = computeBoardStats(usageHistory);
    const ink = isDark ? '#f1f5f9' : '#262830';
    const muted = isDark ? '#94a3b8' : '#64748b';
    const red = isDark ? '#f87171' : '#dc2626';
    const gold = '#f59e0b';
    const goldBg = isDark ? 'rgba(245,158,11,0.18)' : '#fef3c7';
    const trackBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(38,40,48,0.08)';
    const divider = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(120,105,86,0.22)';

    const padX = compact ? 9 : 14;
    const leftW = Math.round(w * 0.56) - padX;
    const divX = x + padX + leftW + (compact ? 6 : 10);
    const rightX = divX + (compact ? 7 : 11);
    const rightW = x + w - padX - rightX;

    // 1. Left: 🏆 销冠龙虎榜 (4 interns ranked by 7-day token output, power-scaled so ratios stay readable)
    const maxTok = Math.max(1, stats.ranking[0]?.tokens || 1);
    const rowStart = y + (compact ? 17 : 26);
    const rowStep = compact ? 12.2 : 24;
    const barH = compact ? 5.2 : 9;
    const nameW = compact ? 53 : 76;
    const valW = compact ? 27 : 42;
    const maxBarW = Math.max(18, leftW - nameW - valW - 5);

    const rankRows = stats.ranking.map((r, i) => {
      const ry = rowStart + i * rowStep;
      const isChamp = i === 0 && r.tokens > 0;
      const scaledRatio = r.tokens > 0 ? Math.max(0.14, Math.pow(r.tokens / maxTok, 0.48)) : 0;
      const bw = r.tokens > 0 ? Math.max(5, maxBarW * scaledRatio) : 0;
      const badge = isChamp ? '👑' : `${i + 1}.`;
      const rowBg = isChamp
        ? `<rect x="${x + padX - 2}" y="${(ry - (compact ? 2.5 : 4)).toFixed(1)}" width="${leftW + 4}" height="${(rowStep - (compact ? 1.5 : 3)).toFixed(1)}" rx="3" fill="${goldBg}"/>`
        : '';
      const barY = ry + (compact ? 1.2 : 3);
      return `<g>
        ${rowBg}
        <text x="${x + padX}" y="${(ry + (compact ? 6 : 11)).toFixed(1)}" font-size="${compact ? 6.8 : 10.8}" font-weight="${isChamp ? 700 : 600}" fill="${isChamp ? '#b45309' : ink}">${badge} ${escHtml(compact ? r.name : r.full)}</text>
        <rect x="${x + padX + nameW}" y="${barY.toFixed(1)}" width="${maxBarW}" height="${barH}" rx="2.5" fill="${trackBg}"/>
        ${bw > 0 ? `<rect x="${x + padX + nameW}" y="${barY.toFixed(1)}" width="${bw.toFixed(1)}" height="${barH}" rx="2.5" fill="${isChamp ? gold : r.color}"/>` : ''}
        <text x="${x + padX + leftW}" y="${(ry + (compact ? 6 : 11)).toFixed(1)}" text-anchor="end" font-size="${compact ? 6.4 : 10}" font-weight="${isChamp ? 700 : 500}" fill="${isChamp ? red : muted}">${compactNum(r.tokens)}</text>
      </g>`;
    }).join('');

    // 2. Right: 🔔 今日开单喜报 & 目标冲刺进度条 + 开单铜锣
    const pct = Math.min(1, stats.todayPrompts / stats.avgPrompts);
    const exceeded = stats.todayPrompts >= stats.avgPrompts;
    const remain = Math.max(0, stats.avgPrompts - stats.todayPrompts);
    const slogan = exceeded
      ? '🔥 破日均！加鸡腿'
      : stats.todayPrompts === 0
        ? '☕ 刚开门，冲鸭！'
        : `冲刺！差 ${remain} 单`;

    const gongCx = rightX + rightW - (compact ? 13 : 20);
    const gongCy = y + (compact ? 29 : 48);
    const gongR = compact ? 10 : 16;

    const progY = y + (compact ? 47 : 86);
    const progH = compact ? 6 : 10;
    const progFillW = Math.max(3, rightW * pct);

    return `<g>
      <!-- Left Header: Red Banner Style -->
      <rect x="${x + padX - 2}" y="${y + (compact ? 4 : 6)}" width="${leftW + 4}" height="${compact ? 10.5 : 16}" rx="2.5" fill="${red}" fill-opacity="0.12"/>
      <text x="${x + padX + 2}" y="${y + (compact ? 11.5 : 17.5)}" font-size="${compact ? 7.4 : 11}" font-weight="700" fill="${red}">🏆 本周销冠龙虎榜</text>
      <text x="${x + padX + leftW}" y="${y + (compact ? 11.5 : 17.5)}" text-anchor="end" font-size="${compact ? 6.2 : 9.5}" fill="${muted}">7日算力</text>
      ${rankRows}

      <!-- Center Divider -->
      <line x1="${divX}" y1="${y + 6}" x2="${divX}" y2="${y + h - 6}" stroke="${divider}" stroke-width="1" stroke-dasharray="2.5 2.5"/>

      <!-- Right Header: 今日喜报 -->
      <rect x="${rightX}" y="${y + (compact ? 4 : 6)}" width="${rightW}" height="${compact ? 10.5 : 16}" rx="2.5" fill="${gold}" fill-opacity="0.18"/>
      <text x="${rightX + 3}" y="${y + (compact ? 11.5 : 17.5)}" font-size="${compact ? 7.4 : 11}" font-weight="700" fill="${isDark ? '#fbbf24' : '#b45309'}">🔔 今日开单喜报</text>

      <!-- Big Order Count -->
      <text x="${rightX + 2}" y="${y + (compact ? 33 : 54)}" font-size="${compact ? 16 : 26}" font-weight="800" fill="${red}">${stats.todayPrompts}</text>
      <text x="${rightX + (compact ? 36 : 58)}" y="${y + (compact ? 32 : 52)}" font-size="${compact ? 7.5 : 11.5}" font-weight="600" fill="${muted}">单</text>
      <text x="${rightX + 2}" y="${y + (compact ? 43 : 71)}" font-size="${compact ? 6.4 : 10}" fill="${muted}">日均 ${stats.avgPrompts} 单 · 薪 ${compactNum(stats.todayTokens)}</text>

      <!-- Golden Sales Gong -->
      <g>
        <line x1="${gongCx - gongR}" y1="${gongCy - gongR - 2}" x2="${gongCx + gongR}" y2="${gongCy - gongR - 2}" stroke="#92400e" stroke-width="${compact ? 1.8 : 2.6}" stroke-linecap="round"/>
        <circle cx="${gongCx}" cy="${gongCy}" r="${gongR}" fill="#f59e0b" stroke="#b45309" stroke-width="1.3"/>
        <circle cx="${gongCx}" cy="${gongCy}" r="${(gongR * 0.65).toFixed(1)}" fill="#fbbf24" stroke="#d97706" stroke-width="0.9"/>
        <circle cx="${gongCx}" cy="${gongCy}" r="${(gongR * 0.25).toFixed(1)}" fill="#fef3c7"/>
      </g>

      <!-- Target Sprint Bar -->
      <rect x="${rightX}" y="${progY}" width="${rightW}" height="${progH}" rx="${progH / 2}" fill="${trackBg}"/>
      <rect x="${rightX}" y="${progY}" width="${progFillW.toFixed(1)}" height="${progH}" rx="${progH / 2}" fill="${exceeded ? '#f59e0b' : red}"/>

      <!-- Boss Slogan -->
      <text x="${rightX + rightW / 2}" y="${y + (compact ? 64 : 114)}" text-anchor="middle" font-size="${compact ? 7 : 10.5}" font-weight="700" fill="${exceeded ? '#d97706' : red}">${escHtml(slogan)}</text>
    </g>`;
  }

  function drawPixelFallbackBoardSvg(isDark, box) {
    const { x, y, w, h } = box;
    const ink = isDark ? '#e2e8f0' : '#334155';
    const muted = isDark ? '#94a3b8' : '#64748b';
    const axis = isDark ? '#475569' : '#94a3b8';
    const grid = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(38,40,48,0.08)';
    const divider = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(120,105,86,0.22)';

    const padX = 14;
    const halfW = Math.round((w - padX * 2 - 18) / 2);
    const leftX = x + padX;
    const divX = leftX + halfW + 9;
    const rightX = divX + 9;

    const plotTop = y + 28;
    const plotH = h - 42;
    const baseY = plotTop + plotH;

    // Left: 6-bar pixel histogram
    const bars = [
      { ratio: 0.42, color: '#5b6ef5', cap: '#93c5fd' },
      { ratio: 0.72, color: '#d97757', cap: '#fdba74' },
      { ratio: 0.54, color: '#10a37f', cap: '#6ee7b7' },
      { ratio: 0.92, color: '#f59e0b', cap: '#fde68a' },
      { ratio: 0.66, color: '#2563eb', cap: '#93c5fd' },
      { ratio: 0.80, color: '#8b5cf6', cap: '#ddd6fe' },
    ];
    const barGap = 6;
    const barW = Math.floor((halfW - 14 - barGap * (bars.length - 1)) / bars.length);
    const barsSvg = bars.map((b, i) => {
      const bh = Math.max(8, Math.round(plotH * b.ratio));
      const bx = leftX + 10 + i * (barW + barGap);
      const by = baseY - bh;
      return `<rect x="${bx}" y="${by}" width="${barW}" height="${bh}" fill="${b.color}"/>
        <rect x="${bx}" y="${by}" width="${barW}" height="3" fill="${b.cap}"/>`;
    }).join('');

    // Right: crisp pixel line chart with square nodes & stepped fill
    const ptsNorm = [0.30, 0.56, 0.44, 0.78, 0.64, 0.90, 0.74];
    const lineCol = isDark ? '#38bdf8' : '#0284c7';
    const nodeCol = '#f59e0b';
    const stepX = (halfW - 18) / (ptsNorm.length - 1);
    const pts = ptsNorm.map((r, i) => ({
      px: Math.round(rightX + 10 + i * stepX),
      py: Math.round(baseY - Math.max(8, plotH * r)),
    }));
    const areaPts = `${pts[0].px},${baseY} ${pts.map((p) => `${p.px},${p.py}`).join(' ')} ${pts[pts.length - 1].px},${baseY}`;
    const linePts = pts.map((p) => `${p.px},${p.py}`).join(' ');
    const nodesSvg = pts.map((p) => `<rect x="${p.px - 2.5}" y="${p.py - 2.5}" width="5" height="5" fill="${nodeCol}" stroke="${isDark ? '#1e222b' : '#ffffff'}" stroke-width="1"/>`).join('');

    const gridYs = [0.25, 0.5, 0.75].map((r) => Math.round(plotTop + plotH * r));
    const leftGrid = gridYs.map((gy) => `<line x1="${leftX + 4}" y1="${gy}" x2="${leftX + halfW}" y2="${gy}" stroke="${grid}" stroke-width="1" stroke-dasharray="3 3"/>`).join('');
    const rightGrid = gridYs.map((gy) => `<line x1="${rightX + 4}" y1="${gy}" x2="${rightX + halfW}" y2="${gy}" stroke="${grid}" stroke-width="1" stroke-dasharray="3 3"/>`).join('');

    return `<g shape-rendering="crispEdges">
      <rect x="${leftX - 2}" y="${y + 6}" width="${halfW + 4}" height="15" rx="2" fill="${isDark ? 'rgba(91,110,245,0.16)' : 'rgba(91,110,245,0.10)'}"/>
      <text x="${leftX + 3}" y="${y + 17}" font-size="10.5" font-weight="700" fill="${ink}">📊 PIXEL BAR</text>
      <text x="${leftX + halfW - 2}" y="${y + 17}" text-anchor="end" font-size="9" fill="${muted}">IDLE</text>
      ${leftGrid}
      <line x1="${leftX + 4}" y1="${plotTop}" x2="${leftX + 4}" y2="${baseY}" stroke="${axis}" stroke-width="2"/>
      <line x1="${leftX + 4}" y1="${baseY}" x2="${leftX + halfW}" y2="${baseY}" stroke="${axis}" stroke-width="2"/>
      ${barsSvg}

      <line x1="${divX}" y1="${y + 8}" x2="${divX}" y2="${y + h - 6}" stroke="${divider}" stroke-width="1" stroke-dasharray="2.5 2.5"/>

      <rect x="${rightX - 2}" y="${y + 6}" width="${halfW + 4}" height="15" rx="2" fill="${isDark ? 'rgba(56,189,248,0.16)' : 'rgba(2,132,199,0.10)'}"/>
      <text x="${rightX + 3}" y="${y + 17}" font-size="10.5" font-weight="700" fill="${ink}">📈 PIXEL LINE</text>
      <text x="${rightX + halfW - 2}" y="${y + 17}" text-anchor="end" font-size="9" fill="${muted}">TREND</text>
      ${rightGrid}
      <line x1="${rightX + 4}" y1="${plotTop}" x2="${rightX + 4}" y2="${baseY}" stroke="${axis}" stroke-width="2"/>
      <line x1="${rightX + 4}" y1="${baseY}" x2="${rightX + halfW}" y2="${baseY}" stroke="${axis}" stroke-width="2"/>
      <polygon points="${areaPts}" fill="${lineCol}" fill-opacity="0.16"/>
      <polyline points="${linePts}" fill="none" stroke="${lineCol}" stroke-width="2.4" stroke-linejoin="miter"/>
      ${nodesSvg}
    </g>`;
  }

  function drawWallWhiteboard(usageHistory, isDark) {
    const bg = isDark ? '#1e222b' : '#fffdf8';
    const frame = isDark ? '#475569' : '#c5bdb0';
    const ink = isDark ? '#e2e8f0' : '#334155';
    const red = isDark ? '#f87171' : '#dc2626';
    const track = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(38,40,48,0.1)';
    const bx = 360;
    const by = 64;
    const bw = 200;
    const bh = 56;

    if (!Array.isArray(usageHistory?.days) || usageHistory.days.length === 0) {
      const axis = isDark ? '#64748b' : '#94a3b8';
      const grid = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(38,40,48,0.08)';
      const barBaseY = by + 48;
      const wallBars = [
        { x: bx + 18, h: 14, col: '#5b6ef5', cap: '#93c5fd' },
        { x: bx + 32, h: 24, col: '#d97757', cap: '#fdba74' },
        { x: bx + 46, h: 18, col: '#10a37f', cap: '#6ee7b7' },
        { x: bx + 60, h: 31, col: '#f59e0b', cap: '#fde68a' },
        { x: bx + 74, h: 22, col: '#2563eb', cap: '#93c5fd' },
      ];
      const wallBarsSvg = wallBars.map((b) => `<rect x="${b.x}" y="${barBaseY - b.h}" width="10" height="${b.h}" fill="${b.col}"/><rect x="${b.x}" y="${barBaseY - b.h}" width="10" height="2" fill="${b.cap}"/>`).join('');

      const lineCol = isDark ? '#38bdf8' : '#0284c7';
      const linePts = [
        [bx + 110, by + 40],
        [bx + 125, by + 30],
        [bx + 140, by + 35],
        [bx + 155, by + 20],
        [bx + 170, by + 26],
        [bx + 185, by + 15],
      ];
      const polyStr = linePts.map((p) => p.join(',')).join(' ');
      const areaStr = `${linePts[0][0]},${barBaseY} ${polyStr} ${linePts[linePts.length - 1][0]},${barBaseY}`;
      const nodesSvg = linePts.map(([px, py]) => `<rect x="${px - 2}" y="${py - 2}" width="4" height="4" fill="#f59e0b"/>`).join('');

      return `<g class="ag-iso-clickable" data-ag-station="board">
        <title>像素展示白板（点击查看 &amp; 敲锣鼓劲）</title>
        <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="4" fill="${bg}" stroke="${frame}" stroke-width="1.8"/>
        <rect x="${bx + 5}" y="${by + 5}" width="4" height="4" rx="1" fill="#dc2626"/>
        <rect x="${bx + bw - 9}" y="${by + 5}" width="4" height="4" rx="1" fill="#f59e0b"/>

        <g shape-rendering="crispEdges">
          <line x1="${bx + 14}" y1="${by + 24}" x2="${bx + 88}" y2="${by + 24}" stroke="${grid}" stroke-width="1"/>
          <line x1="${bx + 14}" y1="${by + 36}" x2="${bx + 88}" y2="${by + 36}" stroke="${grid}" stroke-width="1"/>
          <line x1="${bx + 14}" y1="${by + 13}" x2="${bx + 14}" y2="${barBaseY}" stroke="${axis}" stroke-width="1.5"/>
          <line x1="${bx + 14}" y1="${barBaseY}" x2="${bx + 88}" y2="${barBaseY}" stroke="${axis}" stroke-width="1.5"/>
          ${wallBarsSvg}

          <line x1="${bx + 96}" y1="${by + 10}" x2="${bx + 96}" y2="${by + bh - 8}" stroke="${frame}" stroke-width="1.2" stroke-dasharray="3 3"/>

          <line x1="${bx + 106}" y1="${by + 24}" x2="${bx + 188}" y2="${by + 24}" stroke="${grid}" stroke-width="1"/>
          <line x1="${bx + 106}" y1="${by + 36}" x2="${bx + 188}" y2="${by + 36}" stroke="${grid}" stroke-width="1"/>
          <line x1="${bx + 106}" y1="${by + 13}" x2="${bx + 106}" y2="${barBaseY}" stroke="${axis}" stroke-width="1.5"/>
          <line x1="${bx + 106}" y1="${barBaseY}" x2="${bx + 188}" y2="${barBaseY}" stroke="${axis}" stroke-width="1.5"/>
          <polygon points="${areaStr}" fill="${lineCol}" fill-opacity="0.16"/>
          <polyline points="${polyStr}" fill="none" stroke="${lineCol}" stroke-width="2" shape-rendering="auto"/>
          ${nodesSvg}
        </g>
      </g>`;
    }

    const stats = computeBoardStats(usageHistory);
    const top3 = stats.ranking.slice(0, 3);
    const pct = Math.min(1, stats.todayPrompts / stats.avgPrompts);
    const exceeded = stats.todayPrompts >= stats.avgPrompts;

    // Pure pixel-art wall board: Left = 3-step pixel podium (top 3 colors + tiny crown); Right = big pixel order number + tiny gong + simple bar
    const c1 = top3[0]?.color || '#7c3aed';
    const c2 = top3[1]?.color || '#2563eb';
    const c3 = top3[2]?.color || '#d97757';
    const barW = 78;
    const fillW = Math.max(6, Math.round(barW * pct));

    return `<g class="ag-iso-clickable" data-ag-station="board">
      <title>点击查看门店销冠龙虎榜 &amp; 敲锣鼓劲</title>
      <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="4" fill="${bg}" stroke="${frame}" stroke-width="1.8"/>
      <!-- Corner pixel magnets -->
      <rect x="${bx + 5}" y="${by + 5}" width="4" height="4" rx="1" fill="#dc2626"/>
      <rect x="${bx + bw - 9}" y="${by + 5}" width="4" height="4" rx="1" fill="#f59e0b"/>

      <!-- Left: Pixel 3-Step Champion Podium -->
      <g shape-rendering="crispEdges">
        <!-- #2 Left block -->
        <rect x="${bx + 18}" y="${by + 30}" width="18" height="18" fill="${c2}" fill-opacity="0.88"/>
        <!-- #1 Center Champion block + pixel crown -->
        <rect x="${bx + 38}" y="${by + 20}" width="20" height="28" fill="${c1}" fill-opacity="0.92"/>
        <polygon points="${bx + 42},${by + 18} ${bx + 43},${by + 12} ${bx + 46},${by + 15} ${bx + 48},${by + 11} ${bx + 50},${by + 15} ${bx + 53},${by + 12} ${bx + 54},${by + 18}" fill="#fbbf24" stroke="#b45309" stroke-width="0.9"/>
        <!-- #3 Right block -->
        <rect x="${bx + 60}" y="${by + 36}" width="18" height="12" fill="${c3}" fill-opacity="0.88"/>
        <!-- Base line -->
        <rect x="${bx + 14}" y="${by + 48}" width="68" height="2" fill="${frame}"/>
      </g>

      <!-- Subtle pixel divider -->
      <line x1="${bx + 96}" y1="${by + 10}" x2="${bx + 96}" y2="${by + bh - 8}" stroke="${frame}" stroke-width="1.2" stroke-dasharray="3 3"/>

      <!-- Right: Crisp Big Order Counter + Today Tokens + Mini Golden Gong + Single Sprint Bar -->
      <text x="${bx + 108}" y="${by + 25}" font-size="15.5" font-weight="800" font-family="ui-monospace, SFMono-Regular, monospace" fill="${red}">${stats.todayPrompts}</text>
      <text x="${bx + 139}" y="${by + 24}" font-size="9.5" font-weight="700" font-family="'HanziPen SC', 'Kaiti SC', 'STKaiti', 'Chalkboard SE', 'Comic Sans MS', cursive" fill="${ink}">任务</text>
      <text x="${bx + 108}" y="${by + 38}" font-size="8.6" font-weight="700" font-family="'HanziPen SC', 'Kaiti SC', 'STKaiti', 'Chalkboard SE', 'Comic Sans MS', cursive" fill="${isDark ? '#fbbf24' : '#92400e'}">日薪已结 ${compactNum(stats.todayTokens)}</text>
      <!-- Mini pixel gong -->
      <circle cx="${bx + 176}" cy="${by + 22}" r="8.5" fill="#f59e0b" stroke="#b45309" stroke-width="1.3"/>
      <circle cx="${bx + 176}" cy="${by + 22}" r="4.2" fill="#fde68a"/>
      <!-- Simple sprint bar -->
      <rect x="${bx + 108}" y="${by + 44}" width="${barW}" height="5.5" rx="2" fill="${track}"/>
      <rect x="${bx + 108}" y="${by + 44}" width="${fillW}" height="5.5" rx="2" fill="${exceeded ? '#f59e0b' : red}"/>
    </g>`;
  }

  function drawDeskBlock(cx, cy, topCol, leftCol, rightCol) {
    const rx = 4.6;
    const ry = 2.3;
    const h = 4.8;
    const topPts = `${cx},${cy - h - ry} ${cx + rx},${cy - h} ${cx},${cy - h + ry} ${cx - rx},${cy - h}`;
    const leftPts = `${cx - rx},${cy - h} ${cx},${cy - h + ry} ${cx},${cy + ry} ${cx - rx},${cy}`;
    const rightPts = `${cx},${cy - h + ry} ${cx + rx},${cy - h} ${cx + rx},${cy} ${cx},${cy + ry}`;
    return `<g stroke="#475569" stroke-width="0.65" stroke-linejoin="round">
      <polygon points="${leftPts}" fill="${leftCol}"/>
      <polygon points="${rightPts}" fill="${rightCol}"/>
      <polygon points="${topPts}" fill="${topCol}"/>
    </g>`;
  }

  function drawIsoStation(cfg, data, championKey, quota, isSelected = false) {
    const { key, x, y, shirt, hair, deskTop, deskSide } = cfg;
    const waitN = data.waiting.length;
    const runN = data.running.length;
    const unreadN = data.unread.length;
    const strikeInfo = waitN === 0 && runN === 0 && unreadN === 0 ? getStrikeInfo(quota) : null;
    const salutePhrase = salutingStations.get(key);
    const isSaluting = Boolean(salutePhrase) && waitN === 0 && runN === 0 && unreadN === 0 && !strikeInfo;
    const isChampion = championKey === key;
    const state = waitN > 0 ? 'waiting' : runN > 0 ? 'running' : unreadN > 0 ? 'unread' : strikeInfo ? 'strike' : isSaluting ? 'salute' : 'idle';

    const glow = state === 'waiting'
      ? `<ellipse cx="0" cy="14" rx="74" ry="38" fill="url(#ag-glow-amber)"/>`
      : state === 'running'
        ? `<ellipse cx="0" cy="14" rx="68" ry="34" fill="url(#ag-glow-blue)"/>`
        : state === 'unread'
          ? `<ellipse cx="0" cy="14" rx="62" ry="30" fill="url(#ag-glow-indigo)"/>`
          : state === 'strike'
            ? `<ellipse cx="0" cy="14" rx="70" ry="35" fill="url(#ag-glow-red)"/>`
            : '';

    const screenFill = state === 'waiting' ? '#fef3c7' : state === 'running' ? '#dbeafe' : state === 'unread' ? '#e0e7ff' : state === 'strike' ? '#fee2e2' : '#cbd5e1';
    const screenGraphic = state === 'waiting'
      ? `<rect x="-3" y="-33" width="3" height="7" fill="#d97706"/><rect x="-3" y="-24" width="3" height="2.5" fill="#d97706"/>`
      : state === 'running'
        ? `<g class="ag-iso-glow"><line x1="-10" y1="-32" x2="2" y2="-26" stroke="#2563eb" stroke-width="2"/><line x1="-10" y1="-27" x2="6" y2="-19" stroke="#60a5fa" stroke-width="2"/><line x1="-10" y1="-22" x2="-1" y2="-17" stroke="#2563eb" stroke-width="2"/></g>`
        : state === 'unread'
          ? `<line x1="-8" y1="-29" x2="4" y2="-23" stroke="#6366f1" stroke-width="2"/>`
          : state === 'strike'
            ? `<g stroke="#dc2626" stroke-width="2" stroke-linecap="round"><line x1="-7" y1="-29" x2="2" y2="-20"/><line x1="2" y1="-29" x2="-7" y2="-20"/></g>`
            : '';

    // Character poses:
    // - waiting: raising arm waving + "! 等待确认"
    // - running: energetic alternating typing hands + head focus bob + rising code sparkle
    // - unread (only): holding up a crisp white report document with both hands
    // - salute (idle clicked): stands up straight and gives a crisp salute!
    // - idle: calm seated pose holding coffee mug
    const armsSvg = state === 'waiting'
      ? `<g class="ag-iso-wave"><path d="M18,-20 L30,-38" stroke="${shirt}" stroke-width="5" stroke-linecap="round"/><circle cx="31" cy="-40" r="3" fill="#f3c6a5"/><path d="M5,-16 L-3,-6" stroke="${shirt}" stroke-width="4.5" stroke-linecap="round"/></g>`
      : state === 'running'
        ? `<g>
            <g class="ag-iso-type-l"><path d="M7,-16 L-6,-4" stroke="${shirt}" stroke-width="4.5" stroke-linecap="round"/><circle cx="-7" cy="-3" r="2.4" fill="#f3c6a5"/></g>
            <g class="ag-iso-type-r"><path d="M19,-13 L5,-1" stroke="${shirt}" stroke-width="4.5" stroke-linecap="round"/><circle cx="4" cy="0" r="2.4" fill="#f3c6a5"/></g>
          </g>`
        : state === 'unread'
          ? `<g class="ag-iso-hold-doc">
              <path d="M6,-17 L-2,-34" stroke="${shirt}" stroke-width="4.5" stroke-linecap="round"/>
              <path d="M21,-17 L28,-34" stroke="${shirt}" stroke-width="4.5" stroke-linecap="round"/>
              <!-- Raised Document / Report Sheet -->
              <g transform="translate(13, -46)">
                <path d="M-12,-12 L6,-12 L12,-6 L12,14 L-12,14 Z" fill="#ffffff" stroke="#4f46e5" stroke-width="1.6" stroke-linejoin="round"/>
                <polygon points="6,-12 6,-6 12,-6" fill="#c7d2fe" stroke="#4f46e5" stroke-width="1.1" stroke-linejoin="round"/>
                <line x1="-7" y1="-4" x2="5" y2="-4" stroke="#6366f1" stroke-width="2" stroke-linecap="round"/>
                <line x1="-7" y1="1.5" x2="7" y2="1.5" stroke="#94a3b8" stroke-width="1.8" stroke-linecap="round"/>
                <line x1="-7" y1="6.5" x2="3" y2="6.5" stroke="#94a3b8" stroke-width="1.8" stroke-linecap="round"/>
              </g>
              <circle cx="-2" cy="-35" r="2.6" fill="#f3c6a5"/>
              <circle cx="28" cy="-35" r="2.6" fill="#f3c6a5"/>
            </g>`
          : state === 'strike'
            ? `<g>
                <path d="M5,-16 L-2,-8" stroke="${shirt}" stroke-width="4.5" stroke-linecap="round"/>
                <!-- Right arm waving a wooden protest picket sign -->
                <g class="ag-iso-strike">
                  <path d="M21,-17 L29,-31" stroke="${shirt}" stroke-width="4.5" stroke-linecap="round"/>
                  <line x1="29" y1="-28" x2="29" y2="-56" stroke="#92400e" stroke-width="2.4" stroke-linecap="round"/>
                  <rect x="11" y="-71" width="36" height="19" rx="3" fill="#fff5f5" stroke="#dc2626" stroke-width="1.8"/>
                  <text x="29" y="-58" text-anchor="middle" font-size="9.5" font-weight="800" fill="#dc2626">罢工中</text>
                  <circle cx="29" cy="-32" r="2.6" fill="#f3c6a5"/>
                </g>
              </g>`
          : state === 'salute'
            ? `<g>
                <!-- Left arm at attention -->
                <path d="M5,-17 L2,-2" stroke="${shirt}" stroke-width="4.5" stroke-linecap="round"/>
                <circle cx="2" cy="-1" r="2.3" fill="#f3c6a5"/>
                <!-- Right arm bent up to brow in crisp salute -->
                <path d="M22,-17 L30,-25 L21,-34" fill="none" stroke="${shirt}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
                <circle cx="20" cy="-35" r="2.5" fill="#f3c6a5"/>
              </g>`
            : `<g><path d="M10,-16 L2,-7" stroke="${shirt}" stroke-width="4.5" stroke-linecap="round"/><path d="M19,-14 L25,-12" stroke="${shirt}" stroke-width="4.5" stroke-linecap="round"/><rect x="24" y="-17" width="6" height="6" rx="1" fill="#fff" stroke="#475569" stroke-width="1"/><rect x="25" y="-16" width="4" height="2" fill="#92400e"/></g>`;

    const legsSvg = state === 'salute'
      ? `<path d="M10,0 L10,16" stroke="#334155" stroke-width="4.5" stroke-linecap="round"/><path d="M18,0 L18,16" stroke="#1e293b" stroke-width="4.5" stroke-linecap="round"/>`
      : `<path d="M12,2 L4,10" stroke="#334155" stroke-width="4.5" stroke-linecap="round"/><path d="M18,5 L10,13" stroke="#1e293b" stroke-width="4.5" stroke-linecap="round"/>`;

    const headClass = state === 'running' ? 'ag-iso-work-head' : '';

    // Desk energy shown as playful pixel wooden blocks stacked on the right side of the desk
    const stamina = getStaminaInfo(quota);
    const blockCount = stamina ? (stamina.pct <= 0 ? 0 : Math.min(5, Math.ceil(stamina.pct / 20))) : 0;
    const blockSpecs = [
      { cx: 30, cy: 2.5, top: '#fde68a', left: '#fbbf24', right: '#d97706' },
      { cx: 20, cy: 5.5, top: '#a7f3d0', left: '#34d399', right: '#10b981' },
      { cx: 37, cy: 6.5, top: '#bae6fd', left: '#60a5fa', right: '#3b82f6' },
      { cx: 27, cy: 10, top: '#fca5a5', left: '#f87171', right: '#ef4444' },
      { cx: 26, cy: 0.2, top: '#ddd6fe', left: '#a78bfa', right: '#8b5cf6' },
    ];
    const blocksSvg = stamina && blockCount > 0
      ? `<g><title>${escHtml(stamina.tooltip)}</title>${blockSpecs.slice(0, blockCount).map((b) => drawDeskBlock(b.cx, b.cy, b.top, b.left, b.right)).join('')}</g>`
      : '';

    // Subtle tall-narrow pixel conference tent nameplate angled toward the front edge of the desk
    const cw = Math.max(21, Math.round(cfg.name.length * 3.0 + 4));
    const hw = cw / 2;
    const ch = 9.8;
    const nameplateSvg = `<g shape-rendering="crispEdges" transform="translate(-15, 8.2) skewY(26.565)">
      <title>${escHtml(stamina ? `${cfg.name} · ${stamina.tooltip}` : cfg.name)}</title>
      <polygon points="${(-hw + 1).toFixed(1)},${ch} ${(hw + 2.2).toFixed(1)},${ch} ${(hw + 3.4).toFixed(1)},${(ch - 1.6).toFixed(1)} ${(-hw + 2).toFixed(1)},${(ch - 1.6).toFixed(1)}" fill="rgba(38,40,48,0.12)"/>
      <polygon points="${hw.toFixed(1)},0 ${(hw + 2.6).toFixed(1)},${(ch - 1.4).toFixed(1)} ${hw.toFixed(1)},${ch}" fill="#d6d1c7" stroke="#64748b" stroke-width="0.8" stroke-linejoin="round"/>
      <rect x="${(-hw).toFixed(1)}" y="0" width="${cw}" height="${ch}" rx="0.6" fill="#faf7f2" stroke="${isSelected ? cfg.accent : '#64748b'}" stroke-width="${isSelected ? 1.1 : 0.8}"/>
      <text x="0" y="6.8" text-anchor="middle" font-size="5" font-weight="600" fill="#475569">${escHtml(cfg.name)}</text>
    </g>`;

    const speechBubble = state === 'waiting'
      ? `<g transform="translate(8, -68)"><g class="ag-iso-wave">
          <rect x="-38" y="-14" width="76" height="22" rx="6" fill="#ffffff" stroke="#d97706" stroke-width="1.6"/>
          <polygon points="-4,8 4,8 0,14" fill="#ffffff" stroke="#d97706" stroke-width="1.4"/>
          <rect x="-5" y="6" width="10" height="3" fill="#ffffff"/>
          <text x="0" y="1" text-anchor="middle" font-size="10.5" font-weight="700" fill="#b45309">! 等待确认</text>
        </g></g>`
      : state === 'salute'
        ? `<g transform="translate(18, -76)"><g class="ag-iso-wave">
            <rect x="-46" y="-14" width="92" height="22" rx="6" fill="#ffffff" stroke="#10b981" stroke-width="1.6"/>
            <polygon points="-4,8 4,8 0,14" fill="#ffffff" stroke="#10b981" stroke-width="1.4"/>
            <rect x="-5" y="6" width="10" height="3" fill="#ffffff"/>
            <text x="0" y="1" text-anchor="middle" font-size="10" font-weight="700" fill="#047857">${escHtml(salutePhrase || '老板好！随时待命')}</text>
          </g></g>`
        : state === 'idle'
          ? `<g transform="translate(27, -45)"><g class="ag-iso-zzz">
              <text x="0" y="0" font-size="9.5" font-weight="800" fill="#64748b" stroke="#ffffff" stroke-width="2.6" paint-order="stroke">zZ</text>
            </g></g>`
          : '';

    // Cute tiny subagent robot standing next to desk
    const helperBot = data.subagentTotal > 0
      ? `<g transform="translate(52, 8)"><g class="ag-iso-wave">
          <ellipse cx="0" cy="14" rx="10" ry="5" fill="rgba(38,40,48,0.14)"/>
          <rect x="-8" y="-12" width="16" height="12" rx="3" fill="#e2e8f0" stroke="#334155" stroke-width="1.3"/>
          <rect x="-5" y="-8" width="3" height="3" fill="#2563eb"/>
          <rect x="2" y="-8" width="3" height="3" fill="#2563eb"/>
          <line x1="0" y1="-12" x2="0" y2="-17" stroke="#334155" stroke-width="1.3"/>
          <circle cx="0" cy="-18" r="2" fill="#38bdf8"/>
          <rect x="-6" y="0" width="12" height="10" rx="2" fill="#cbd5e1" stroke="#334155" stroke-width="1.3"/>
          <rect x="-4" y="10" width="3" height="4" fill="#475569"/>
          <rect x="1" y="10" width="3" height="4" fill="#475569"/>
        </g></g>`
      : '';

    return `<g class="ag-iso-clickable" data-ag-station="${key}" transform="translate(${x}, ${y})">
      ${glow}
      <!-- Floor Shadow -->
      <polygon points="-50,14 2,-12 52,14 0,40" fill="rgba(38,40,48,0.10)"/>
      <!-- Rolling Chair (back-right) -->
      <ellipse cx="22" cy="10" rx="14" ry="7" fill="rgba(38,40,48,0.12)"/>
      <line x1="22" y1="2" x2="22" y2="10" stroke="#475569" stroke-width="2.5"/>
      <polygon points="10,-2 22,-8 34,-2 22,4" fill="#64748b" stroke="#334155" stroke-width="1.2"/>
      <path d="M26,-4 L34,-22 L24,-27 L16,-9 Z" fill="#94a3b8" stroke="#334155" stroke-width="1.2"/>
      <!-- Intern Character -->
      <g class="${state === 'salute' ? 'ag-iso-salute' : ''}" transform="translate(6, -6)">
        <!-- Legs -->
        ${legsSvg}
        <!-- Torso / Hoodie with Vendor Logo -->
        <path d="M3,-21 Q14,-26 24,-19 L25,-1 Q14,5 3,-1 Z" fill="${shirt}" stroke="#262830" stroke-width="1.3"/>
        ${renderVendorLogo(key)}
        <!-- Head -->
        <g class="${headClass}">
          <rect x="6" y="-38" width="15" height="15" rx="4" fill="#f3c6a5" stroke="#262830" stroke-width="1.3"/>
          <path d="M5,-33 Q6,-41 14,-41 Q22,-41 22,-32 Q18,-35 13,-35 Q8,-35 5,-33 Z" fill="${hair}"/>
          ${isChampion ? `<polygon points="8,-41 9,-48 12,-44 14,-49 16,-44 19,-48 20,-41" fill="#fbbf24" stroke="#b45309" stroke-width="1.1" stroke-linejoin="round"/>` : ''}
          <rect x="9" y="-31" width="2" height="2.4" rx="0.5" fill="#1f2937"/>
          <rect x="15" y="-31" width="2" height="2.4" rx="0.5" fill="#1f2937"/>
        </g>
        ${armsSvg}
      </g>
      <!-- 2.5D Isometric Desk Legs -->
      <line x1="-42" y1="8" x2="-42" y2="28" stroke="#64748b" stroke-width="2.4"/>
      <line x1="-4" y1="26" x2="-4" y2="44" stroke="#64748b" stroke-width="2.4"/>
      <line x1="42" y1="6" x2="42" y2="24" stroke="#64748b" stroke-width="2.4"/>
      <!-- 2.5D Isometric Desk Top -->
      <polygon points="-46,4 0,-19 46,4 0,27" fill="${deskTop}" stroke="#475569" stroke-width="1.4"/>
      <polygon points="-46,4 0,27 0,32 -46,9" fill="${deskSide}" stroke="#475569" stroke-width="1.2"/>
      <polygon points="0,27 46,4 46,9 0,32" fill="#cbd5e1" stroke="#475569" stroke-width="1.2"/>
      <!-- 2.5D Isometric Monitor -->
      <polygon points="-14,-37 10,-25 10,-7 -14,-19" fill="#334155" stroke="#1e293b" stroke-width="1.3"/>
      <polygon points="-12,-34 8,-24 8,-10 -12,-20" fill="${screenFill}"/>
      ${screenGraphic}
      <line x1="-2" y1="-13" x2="-2" y2="-6" stroke="#475569" stroke-width="2.6"/>
      <polygon points="-8,-6 -2,-9 4,-6 -2,-3" fill="#64748b"/>
      <!-- Keyboard -->
      <polygon points="-4,0 10,-7 18,-3 4,4" fill="#e2e8f0" stroke="#64748b" stroke-width="1"/>
      ${blocksSvg}
      ${nameplateSvg}
      ${helperBot}
      ${speechBubble}
    </g>`;
  }

  function drawIsoRack(bgCount, colabCu, isSelected = false) {
    const active = bgCount > 0;
    const ledColor = active ? '#10b981' : '#94a3b8';
    const hasCu = typeof colabCu === 'number' && Number.isFinite(colabCu);
    const cuNum = hasCu ? String(Math.round(colabCu)) : '--';
    const cuTxt = formatCu(colabCu);
    const bgNum = `×${bgCount}`;
    return `<g class="ag-iso-clickable" data-ag-station="rack" transform="translate(658, 134)">
      <title>${escHtml(`机房服务器：${active ? `后台 ×${bgCount}` : '后台 空闲'}${cuTxt ? ` · Colab ${cuTxt}` : ''}（点击查看机房巡检单）`)}</title>
      <polygon points="-26,38 4,23 34,38 4,53" fill="rgba(38,40,48,0.12)"/>
      <!-- Top -->
      <polygon points="-26,-21 4,-36 32,-22 2,-7" fill="#e2e8f0" stroke="${isSelected ? '#10b981' : '#475569'}" stroke-width="${isSelected ? 1.6 : 1.4}"/>
      <!-- Left Front (Blades) -->
      <polygon points="-26,-21 2,-7 2,43 -26,29" fill="#cbd5e1" stroke="${isSelected ? '#10b981' : '#475569'}" stroke-width="${isSelected ? 1.6 : 1.4}"/>
      <!-- Right Side -->
      <polygon points="2,-7 32,-22 32,28 2,43" fill="#94a3b8" stroke="${isSelected ? '#10b981' : '#475569'}" stroke-width="${isSelected ? 1.6 : 1.4}"/>
      <!-- 3 Server Blade Slots (1: bg tasks, 2: CU, 3: blinking eyes + LED) -->
      <polygon points="-22,-13 0,-2 0,7 -22,-4" fill="#263042"/>
      <polygon points="-22,0 0,11 0,20 -22,9" fill="#263042"/>
      <polygon points="-22,13 0,24 0,33 -22,22" fill="#263042"/>
      <!-- Blade 1 readout (xN) & Blade 2 readout (CU) aligned to isometric slope -->
      <g transform="translate(-13, -3.5) skewY(26.565)" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-weight="700" text-anchor="middle">
        <text x="0" y="2.2" font-size="7.2" fill="${active ? '#86efac' : '#64748b'}">${escHtml(bgNum)}</text>
      </g>
      <g transform="translate(-13, 9.5) skewY(26.565)" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-weight="700" text-anchor="middle">
        <text x="0" y="2.2" font-size="6.8" fill="${hasCu ? '#93c5fd' : '#64748b'}">${escHtml(cuNum)}</text>
      </g>
      <!-- Blade 3: Two tiny blinking eyes inside the bottom dark window -->
      <g shape-rendering="crispEdges" transform="translate(-13, 22) skewY(26.565)">
        <g class="ag-iso-cat-eyes">
          <rect x="-4" y="-1.2" width="2.2" height="2.4" fill="#fde68a"/>
          <rect x="1.8" y="-1.2" width="2.2" height="2.4" fill="#fde68a"/>
        </g>
      </g>
      <!-- LEDs -->
      <circle class="${active ? 'ag-iso-led' : ''}" cx="-3.5" cy="1" r="1.8" fill="${ledColor}"/>
      <circle class="${active ? 'ag-iso-led-2' : ''}" cx="-3.5" cy="14" r="1.8" fill="${hasCu ? '#38bdf8' : '#94a3b8'}"/>
      <circle class="${active ? 'ag-iso-led' : ''}" cx="-3.5" cy="27" r="1.8" fill="${ledColor}"/>
    </g>`;
  }

  function buildPopoverHtml(stationKey, stationMap, bgTasks, usageHistory, quotas, isDark) {
    if (!stationKey) return '';
    if (stationKey === 'board') {
      const hasHistory = Boolean(usageHistory?.days?.length);
      const stats = computeBoardStats(usageHistory);
      const chartSvg = hasHistory
        ? `<svg viewBox="0 0 364 128" style="width:100%;height:auto;display:block;">${drawSalesBoardSvg(usageHistory, isDark, { x: 0, y: 0, w: 364, h: 128, compact: false })}</svg>`
        : `<svg viewBox="0 0 364 128" style="width:100%;height:auto;display:block;">${drawPixelFallbackBoardSvg(isDark, { x: 0, y: 0, w: 364, h: 128 })}</svg>`;
      const footHtml = hasHistory
        ? `<span>本周销冠：👑 <strong style="color:var(--ag-of-ink);">${escHtml(stats.champion?.full || '—')}</strong></span>
           <span>7日累计开单 <strong style="color:var(--ag-of-ink);">${stats.weekPrompts}</strong> 单</span>`
        : `<span>像素展示白板</span>
           <span>接入 howmanyusage 可解锁实时榜</span>`;
      return `<div class="ag-office-popover">
        <div class="ag-pop-head">
          <span class="ag-pop-title">${hasHistory ? '🏆 门店销冠龙虎榜 &amp; 今日喜报' : '📊 像素趋势白板'}</span>
          <div class="ag-pop-actions">
            <button type="button" class="ag-pop-btn primary" data-ag-gong="1">🔔 敲锣鼓劲</button>
            <button type="button" class="ag-pop-btn" data-ag-close-pop="1">关闭</button>
          </div>
        </div>
        <div class="ag-pop-body">
          ${chartSvg}
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--ag-of-muted);padding:2px 6px 0;">
            ${footHtml}
          </div>
        </div>
      </div>`;
    }
    if (stationKey === 'rack') {
      const cuStr = formatCu(quotas?.colabCu);
      const cuCard = cuStr
        ? `<div class="ag-pop-item is-bg" style="flex-direction:row;align-items:center;justify-content:space-between;">
            <span style="font-size:11.5px;font-weight:600;color:var(--ag-of-ink);">⚡ Colab 算力余额</span>
            <span style="font-size:13px;font-weight:800;color:var(--ag-of-green);font-variant-numeric:tabular-nums;">${escHtml(cuStr)}</span>
          </div>`
        : '';
      const listHtml = bgTasks.length
        ? bgTasks.map((b) => `<div class="ag-pop-item is-bg clickable" data-ag-open-cid="${escHtml(b.id)}">
            <div class="ag-pop-item-top"><span class="ag-pop-proj"># ${escHtml(b.project)}</span><span>◎ 后台 ×${b.bgCount} · ${formatRelTime(b.updatedAt)}</span></div>
            <div class="ag-pop-item-title">${escHtml(b.title)}</div>
          </div>`).join('')
        : `<div class="ag-pop-empty">当前没有运行中的后台定时任务</div>`;
      return `<div class="ag-office-popover">
        <div class="ag-pop-head">
          <span class="ag-pop-title"><span class="ag-office-dot" style="background:#10b981"></span>机房巡检单 (${bgTasks.length})</span>
          <div class="ag-pop-actions"><button type="button" class="ag-pop-btn" data-ag-close-pop="1">收起</button></div>
        </div>
        <div class="ag-pop-body">${cuCard}<div class="ag-pop-list">${listHtml}</div></div>
      </div>`;
    }

    const cfg = INTERNS.find((i) => i.key === stationKey);
    const data = stationMap[stationKey];
    if (!cfg || !data) return '';
    const isAgy = stationKey === 'agy';
    const activeItems = [...data.waiting.map((t) => ({ ...t, _st: 'waiting' })), ...data.running.map((t) => ({ ...t, _st: 'running' }))];
    const unreadItems = data.unread;
    const quota = quotas?.[stationKey] || null;
    const stamina = getStaminaInfo(quota);
    const strikeInfo = activeItems.length === 0 && unreadItems.length === 0 ? getStrikeInfo(quota) : null;

    const stampHtml = strikeInfo
      ? `<span class="ag-pop-stamp">✊ 罢工中</span>`
      : unreadItems.length
        ? `<span class="ag-pop-stamp">待批阅 ${unreadItems.length}</span>`
        : activeItems.length
          ? `<span class="ag-pop-stamp is-run">赶工中 ${activeItems.length}</span>`
          : '';

    const renderItem = (t, isUnread) => {
      const cls = t._st === 'waiting' ? 'is-waiting' : t._st === 'running' ? 'is-active' : '';
      if (isAgy) {
        const tag = t._st === 'waiting' ? '● 等老板拍板' : t._st === 'running' ? '⚡ 赶工中' : '✉ 待批阅';
        return `<div class="ag-pop-item ${cls} clickable" data-ag-open-cid="${escHtml(t.id)}">
          <div class="ag-pop-item-top"><span class="ag-pop-proj"># ${escHtml(t.project)}</span><span>${tag} · ${formatRelTime(t.updatedAt)}</span></div>
          <div class="ag-pop-item-title">${escHtml(t.title)}</div>
        </div>`;
      }
      return `<div class="ag-pop-item ${cls}">
        <div class="ag-pop-item-top"><span class="ag-pop-proj"># ${escHtml(t.project)}</span><span>${formatRelTime(t.updatedAt)}</span></div>
        <div class="ag-pop-item-title">${escHtml(t.title)}</div>
        ${t.lastReply ? `<div class="ag-pop-reply">「${escHtml(t.lastReply)}」</div>` : ''}
        <div class="ag-pop-item-foot">
          <button type="button" class="ag-pop-btn handoff" data-ag-handoff-agent="${escHtml(cfg.name)}" data-ag-handoff-proj="${escHtml(t.project)}" data-ag-handoff-title="${escHtml(t.title)}" data-ag-handoff-reply="${escHtml(t.lastReply || '')}" data-ag-handoff-cmd="${escHtml(t.continueCmd || '')}">↪ 交给 Gemini</button>
          ${t.continueCmd ? `<button type="button" class="ag-pop-btn primary" data-ag-copy="${escHtml(t.continueCmd)}">📋 复制指令</button>` : ''}
          ${isUnread ? `<button type="button" class="ag-pop-btn approve" data-ag-mark-read="${stationKey}" data-ag-tid="${escHtml(t.id)}" data-ag-ts="${t.updatedAt || 0}">✓ 批阅通过</button>` : ''}
        </div>
      </div>`;
    };

    const sections = [];
    if (activeItems.length) {
      sections.push(`<div><div class="ag-pop-sec-title"><span class="ag-office-dot" style="background:var(--ag-of-blue)"></span>手头在忙 (${activeItems.length})</div><div class="ag-pop-list">${activeItems.map((t) => renderItem(t, false)).join('')}</div></div>`);
    }
    if (unreadItems.length) {
      sections.push(`<div><div class="ag-pop-sec-title"><span class="ag-office-dot" style="background:var(--ag-of-indigo)"></span>递交的汇报 (${unreadItems.length})</div><div class="ag-pop-list">${unreadItems.map((t) => renderItem(t, true)).join('')}</div></div>`);
    }
    if (!sections.length) {
      if (strikeInfo) {
        sections.push(`<div class="ag-pop-item" style="border-left-color:var(--ag-of-red);">
          <div class="ag-pop-item-title">✊ ${cfg.name} 正在罢工</div>
          <div class="ag-pop-reply">「老板，${escHtml(strikeInfo.reason)}，额度快见底了，等重置后立刻复工！」</div>
        </div>`);
      } else {
        sections.push(`<div class="ag-pop-empty">☕ ${cfg.name} 当前空闲，没有在忙或待批阅的汇报</div>`);
      }
    }

    const staminaLine = stamina
      ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;color:var(--ag-of-muted);padding:0 2px;">
          <span>${escHtml(stamina.tooltip)}</span>
          <span style="display:inline-flex;align-items:center;gap:2px;">${[0, 1, 2, 3, 4].map((idx) => {
            const filled = idx < (stamina.pct > 0 ? Math.max(1, Math.min(5, Math.round((stamina.pct / 100) * 5))) : 0);
            return `<span style="width:8px;height:4px;border-radius:1px;background:${filled ? stamina.color : 'rgba(128,128,128,0.22)'};"></span>`;
          }).join('')}</span>
        </div>`
      : '';

    return `<div class="ag-office-popover">
      <div class="ag-pop-head">
        <span class="ag-pop-title">${renderVendorBadgeHtml(cfg.key)}${cfg.name} · 汇报夹 ${stampHtml}</span>
        <div class="ag-pop-actions">
          ${!isAgy && unreadItems.length ? `<button type="button" class="ag-pop-btn approve" data-ag-mark-read="${stationKey}" data-ag-tid="_all">全部批阅</button>` : ''}
          <button type="button" class="ag-pop-btn" data-ag-close-pop="1">收起</button>
        </div>
      </div>
      <div class="ag-pop-body">${staminaLine}${sections.join('')}</div>
    </div>`;
  }

  function clearStudio() {
    document.querySelectorAll('.ag-lite-office, .ag-lite-studio').forEach((n) => n.remove());
    document.querySelectorAll('.ag-lite-studio-host').forEach((n) => n.classList.remove('ag-lite-studio-host'));
  }

  function findNewConvoMount() {
    if (/\/c\/[0-9a-f-]{36}/i.test(location.pathname)) return null;
    const activeCv = document.querySelector('[data-testid="conversation-view"][data-cascade-id]');
    if (activeCv) {
      const attrId = activeCv.getAttribute('data-cascade-id');
      if (attrId && attrId !== 'conversation') return null;
    }
    const boxes = document.querySelectorAll('[data-testid="agent-input-box"]');
    let targetBox = null;
    for (const ib of boxes) {
      if (resolveCascadeId(ib)) continue;
      const r = ib.getBoundingClientRect();
      if (r.width > 200 && r.height > 30) {
        targetBox = ib;
        break;
      }
    }
    if (!targetBox) return null;

    let child = targetBox;
    let host = targetBox.parentElement;
    let fallbackMount = null;
    for (let i = 0; i < 8 && host && host !== document.body; i++) {
      const style = getComputedStyle(host);
      const r = host.getBoundingClientRect();
      if (r.height >= 360 && r.width >= 480) {
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          return { host, afterEl: child };
        }
        if (style.display === 'flex' && style.flexDirection === 'column') {
          // Prefer outermost flex-column container so multi-line input never hijacks mount host
          fallbackMount = { host, afterEl: child };
        }
      }
      child = host;
      host = host.parentElement;
    }
    return fallbackMount;
  }

  function syncStudio() {
    if (destroyed) return;
    const mount = findNewConvoMount();
    if (!mount) {
      clearStudio();
      return;
    }
    const h = ensureHooks(true);
    if (!h?.store) return;
    const st = h.store.getState();
    const agyData = collectAgyItems(st);
    const ext = window.__agLiteExternalAgents || { claude: [], codex: [], dsh: [] };
    const readMarks = getReadMarks();

    const stationMap = {
      agy: agyData,
      claude: buildExternalStation('claude', ext.claude, readMarks),
      codex: buildExternalStation('codex', ext.codex, readMarks),
      dsh: buildExternalStation('dsh', ext.dsh, readMarks),
    };
    lastStationMap = stationMap;
    const bgTasks = agyData.bgTasks;

    const uiTheme = st?.colorTheme?._jetskiThemeData?.uiTheme || '';
    const isDark = uiTheme === 'vs-dark' || uiTheme === 'hc-black' || document.documentElement.classList.contains('dark');

    const timeBucket = Math.floor(Date.now() / 30000);

    const sig = JSON.stringify({
      isDark,
      selectedStation,
      saluting: [...salutingStations.entries()],
      timeBucket,
      histDays: ext.usageHistory?.days?.length || 0,
      histLast: ext.usageHistory?.days?.slice(-1)?.[0] || null,
      quotas: ext.quotas || null,
      bg: bgTasks.map((b) => [b.id, b.bgCount, b.updatedAt]),
      stations: INTERNS.map((i) => {
        const d = stationMap[i.key];
        return [
          i.key,
          d.subagentTotal,
          d.waiting.map((x) => [x.id, x.updatedAt]),
          d.running.map((x) => [x.id, x.updatedAt]),
          d.unread.map((x) => [x.id, x.updatedAt]),
        ];
      }),
    });

    if (!mount.host.classList.contains('ag-lite-studio-host')) {
      mount.host.classList.add('ag-lite-studio-host');
    }
    document.querySelectorAll('.ag-lite-studio-host').forEach((n) => {
      if (n !== mount.host) n.classList.remove('ag-lite-studio-host');
    });

    let root = mount.host.querySelector(':scope > .ag-lite-office');
    document.querySelectorAll('.ag-lite-office').forEach((n) => {
      if (n !== root) n.remove();
    });
    if (!root) {
      root = document.createElement('section');
      root.className = 'ag-lite-office';
      root.addEventListener('click', (ev) => {
        const closeBtn = ev.target.closest('[data-ag-close-pop]');
        if (closeBtn) {
          selectedStation = null;
          syncStudio();
          return;
        }
        const handoffBtn = ev.target.closest('[data-ag-handoff-agent]');
        if (handoffBtn) {
          ev.stopPropagation();
          const agName = handoffBtn.getAttribute('data-ag-handoff-agent') || '';
          const proj = handoffBtn.getAttribute('data-ag-handoff-proj') || '';
          const title = handoffBtn.getAttribute('data-ag-handoff-title') || '';
          const reply = handoffBtn.getAttribute('data-ag-handoff-reply') || '';
          const cmd = handoffBtn.getAttribute('data-ag-handoff-cmd') || '';
          const promptText = [
            `请接手继续处理来自 ${agName} 的任务（项目：${proj}）：`,
            `- 原任务：${title}`,
            reply ? `- ${agName} 最新回复摘要：${reply}` : '',
            cmd ? `- 原会话继续命令：${cmd}` : '',
          ].filter(Boolean).join('\n');
          fillNewConvoComposer(promptText);
          selectedStation = null;
          syncStudio();
          return;
        }
        const copyBtn = ev.target.closest('[data-ag-copy]');
        if (copyBtn) {
          ev.stopPropagation();
          copyText(copyBtn.getAttribute('data-ag-copy'));
          const orig = copyBtn.textContent;
          copyBtn.textContent = '已复制 ✓';
          setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = orig; }, 1400);
          return;
        }
        const markBtn = ev.target.closest('[data-ag-mark-read]');
        if (markBtn) {
          ev.stopPropagation();
          markExternalRead(
            markBtn.getAttribute('data-ag-mark-read'),
            markBtn.getAttribute('data-ag-tid'),
            Number(markBtn.getAttribute('data-ag-ts') || 0)
          );
          syncStudio();
          return;
        }
        const openRow = ev.target.closest('[data-ag-open-cid]');
        if (openRow) {
          openConversation(openRow.getAttribute('data-ag-open-cid'));
          return;
        }
        const gongBtn = ev.target.closest('[data-ag-gong]');
        if (gongBtn) {
          ev.stopPropagation();
          salutingStations.clear();
          const cheers = ['收到！冲业绩！', '必拿下销冠！', '老板威武！', '随时开单！'];
          for (const cfg of INTERNS) {
            const sd = lastStationMap && lastStationMap[cfg.key];
            if (sd && sd.waiting.length === 0 && sd.running.length === 0 && sd.unread.length === 0) {
              salutingStations.set(cfg.key, cheers[Math.floor(Math.random() * cheers.length)]);
            }
          }
          if (saluteTimer) clearTimeout(saluteTimer);
          saluteTimer = setTimeout(() => {
            saluteTimer = null;
            salutingStations.clear();
            if (!destroyed) syncStudio();
          }, 2800);
          selectedStation = null;
          syncStudio();
          return;
        }
        const stationEl = ev.target.closest('[data-ag-station]');
        if (stationEl) {
          const sk = stationEl.getAttribute('data-ag-station');
          const sd = lastStationMap && lastStationMap[sk];
          const q = window.__agLiteExternalAgents?.quotas?.[sk] || null;
          const isIdleIntern = sd && sd.waiting.length === 0 && sd.running.length === 0 && sd.unread.length === 0 && !getStrikeInfo(q);
          if (isIdleIntern) {
            const phrases = ['老板好！随时待命', '收到！等您派活', '立正！随时开工'];
            const phrase = phrases[Math.floor(Math.random() * phrases.length)];
            salutingStations.set(sk, phrase);
            if (saluteTimer) clearTimeout(saluteTimer);
            saluteTimer = setTimeout(() => {
              saluteTimer = null;
              salutingStations.clear();
              if (!destroyed) syncStudio();
            }, 2600);
            selectedStation = null;
            syncStudio();
            return;
          }
          selectedStation = selectedStation === sk ? null : sk;
          syncStudio();
          return;
        }
        if (selectedStation && !ev.target.closest('.ag-office-popover')) {
          selectedStation = null;
          syncStudio();
        }
      });
      mount.afterEl.insertAdjacentElement('beforebegin', root);
    } else if (root.nextElementSibling !== mount.afterEl) {
      mount.afterEl.insertAdjacentElement('beforebegin', root);
    }

    if (root.getAttribute('data-ag-office-sig') === sig) return;
    root.setAttribute('data-ag-office-sig', sig);
    root.setAttribute('data-ag-theme', isDark ? 'dark' : 'light');

    // Build isometric plank lines clipped to floor polygon
    const plankLines = [];
    for (let k = -8; k <= 14; k++) {
      const y0 = 130 + k * 24;
      plankLines.push(`<line x1="60" y1="${y0 + 110}" x2="860" y2="${y0 - 110}" stroke="var(--ag-of-plank)" stroke-width="1.2"/>`);
    }

    const svgHtml = `<svg class="ag-office-svg" viewBox="0 0 920 460" aria-label="Agent 2.5D Isometric Office">
      <defs>
        <clipPath id="ag-iso-floor-clip">
          <polygon points="290,134 630,134 830,252 630,412 290,412 90,252"/>
        </clipPath>
        <radialGradient id="ag-glow-amber" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.34"/>
          <stop offset="100%" stop-color="#f59e0b" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="ag-glow-blue" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="ag-glow-indigo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#6366f1" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="ag-glow-red" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#ef4444" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="#ef4444" stop-opacity="0"/>
        </radialGradient>
      </defs>

      <!-- Outer Room Drop Shadow -->
      <polygon points="290,144 630,144 834,262 630,424 290,424 86,262" fill="rgba(24,26,32,0.08)"/>

      <!-- Back-Left Angled Wall -->
      <polygon points="90,174 290,56 290,134 90,252" fill="var(--ag-of-wall-l)" stroke="var(--ag-of-wall-stroke)" stroke-width="1.4" stroke-linejoin="round"/>
      <!-- Back-Center Wall -->
      <polygon points="290,56 630,56 630,134 290,134" fill="var(--ag-of-wall-r)" stroke="var(--ag-of-wall-stroke)" stroke-width="1.4" stroke-linejoin="round"/>
      <!-- Back-Right Angled Wall -->
      <polygon points="630,56 830,174 830,252 630,134" fill="var(--ag-of-wall-l)" stroke="var(--ag-of-wall-stroke)" stroke-width="1.4" stroke-linejoin="round"/>

      <!-- Wall Top Rim (3D thickness) -->
      <polyline points="90,174 290,56 630,56 830,174" fill="none" stroke="var(--ag-of-wall-top)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <polyline points="90,174 290,56 630,56 830,174" fill="none" stroke="var(--ag-of-wall-stroke)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>

      <!-- Back-Wall Whiteboard with live howmanyusage Summary Charts -->
      ${drawWallWhiteboard(ext.usageHistory, isDark)}

      <!-- Wooden Floor -->
      <polygon points="290,134 630,134 830,252 630,412 290,412 90,252" fill="var(--ag-of-floor)" stroke="var(--ag-of-wall-stroke)" stroke-width="1.5" stroke-linejoin="round"/>
      <g clip-path="url(#ag-iso-floor-clip)">
        ${plankLines.join('')}
        <!-- Subtle inner baseboard shadow -->
        <polyline points="90,252 290,134 630,134 830,252" fill="none" stroke="rgba(44,46,53,0.10)" stroke-width="5"/>
      </g>

      <!-- Cozy Corner Potted Plant (far-left) -->
      <g transform="translate(152, 232)">
        <ellipse cx="0" cy="14" rx="13" ry="6" fill="rgba(38,40,48,0.12)"/>
        <polygon points="-9,2 9,2 6,14 -6,14" fill="#c27853" stroke="#7c4a32" stroke-width="1.2"/>
        <ellipse cx="0" cy="2" rx="9" ry="4" fill="#d68c65" stroke="#7c4a32" stroke-width="1"/>
        <path d="M0,0 C-10,-12 -14,-18 -4,-16 C-2,-24 4,-24 5,-14 C14,-18 12,-8 0,0 Z" fill="#34a853" stroke="#1e6f35" stroke-width="1.1"/>
      </g>

      <!-- Top-Right Corner Server Rack -->
      ${drawIsoRack(bgTasks.length, ext.quotas?.colabCu, selectedStation === 'rack')}

      <!-- 4 Intern Isometric Workstations (back-to-front painter's order) -->
      ${(() => {
        const champKey = computeBoardStats(ext.usageHistory).champion?.key || '';
        return INTERNS.map((cfg) => drawIsoStation(cfg, stationMap[cfg.key], champKey, ext.quotas?.[cfg.key] || null, selectedStation === cfg.key)).join('');
      })()}
    </svg>`;

    const popoverHtml = buildPopoverHtml(selectedStation, stationMap, bgTasks, ext.usageHistory, ext.quotas, isDark);
    root.innerHTML = `<div class="ag-office-stage">${svgHtml}${popoverHtml}</div>`;
  }

  window.__agLiteRefreshOffice = syncStudio;

  function syncAll() {
    if (destroyed) return;
    document.querySelectorAll('.ag-lite-bottom-bar, .ag-lite-metrics').forEach((n) => n.remove());
    const footers = document.querySelectorAll('.agy-composer-footer');
    for (const footer of footers) {
      const card = footer.closest('.surface-composer-card') || footer.closest('[data-testid="agent-input-box"]') || footer.parentElement;
      const ib = footer.closest('[data-testid="agent-input-box"]');
      const cid = resolveCascadeId(ib);
      if (!cid) {
        footer.querySelectorAll('.ag-lite-context-ring').forEach((n) => n.remove());
        continue;
      }
      const cached = trajCache.get(cid)?.data || null;
      renderWidgets(footer, card, cached);
      fetchActiveConvo(cid).then((fresh) => {
        if (!destroyed && fresh && footer.isConnected) {
          renderWidgets(footer, card, fresh);
        }
      });
    }
    syncStudio();
  }

  mutObs = new MutationObserver(() => {
    if (destroyed || mutDebounce) return;
    mutDebounce = setTimeout(() => {
      mutDebounce = null;
      if (!destroyed) syncAll();
    }, 250);
  });
  mutObs.observe(document.body, { childList: true, subtree: true });

  pollTimer = setInterval(syncAll, 2500);
  syncAll();

  window.__agLiteHudDestroy = () => {
    destroyed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (storeDebounce) clearTimeout(storeDebounce);
    if (mutDebounce) clearTimeout(mutDebounce);
    if (saluteTimer) clearTimeout(saluteTimer);
    if (storeUnsub) try { storeUnsub(); } catch {}
    if (mutObs) try { mutObs.disconnect(); } catch {}
    document.querySelectorAll('.ag-lite-bottom-bar, .ag-lite-context-ring, .ag-lite-metrics, .ag-lite-studio, .ag-lite-office').forEach((n) => n.remove());
    document.querySelectorAll('.ag-lite-studio-host').forEach((n) => n.classList.remove('ag-lite-studio-host'));
    delete window.__agLiteRefreshOffice;
    delete window.__agLiteSpeedSamples;
    delete window.__agLiteHudDestroy;
  };
})();
