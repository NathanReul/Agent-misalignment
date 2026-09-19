// ─── State ─────────────────────────────────────────────────────────────────

const S = {
  experiments: [],        // loaded from /api/experiments
  liveExperimentId: null, // currently watched experiment
  liveEpisodeId: null,    // currently watched episode (within live experiment)
  liveMode: 'auto',
  waitingForStep: false,
  paused: false,
  sse: null,              // current EventSource
  selectedEpisodeId: null,// episode open in detail view
  runMode: 'auto',        // form state
  models: [],             // form state — [{ id, temperature }]
  currentView: 'welcome',
  historyExperimentId: null, // experiment selected in history view
};

// ─── Routing (show/hide views) ──────────────────────────────────────────────

function showView(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');
  S.currentView = viewId;
}

// ─── Toast ──────────────────────────────────────────────────────────────────

let toastTimer;
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderColor = type === 'error' ? 'var(--red)' : type === 'success' ? 'var(--green)' : 'var(--border)';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ─── API helpers ────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
  return json;
}

// ─── Sidebar ────────────────────────────────────────────────────────────────

async function loadExperiments() {
  try {
    S.experiments = await api('/api/experiments?limit=100');
    renderSidebar();
  } catch (e) {
    console.error(e);
  }
}

function renderSidebar() {
  const list = document.getElementById('experiment-list');
  const count = document.getElementById('sidebar-count');
  count.textContent = `${S.experiments.length} total`;

  if (!S.experiments.length) {
    list.innerHTML = '<div class="empty-state" style="padding:16px;font-size:.8rem">No experiments yet</div>';
    return;
  }

  list.innerHTML = S.experiments.map((exp) => {
    const status = exp.status?.toLowerCase() ?? 'unknown';
    const isActive = exp.experimentId === S.liveExperimentId;
    const scenarioId = exp.config?.scenarioId ?? exp.scenarioId ?? '—';
    const models = Array.isArray(exp.config?.models) ? exp.config.models.map((m) => m.id ?? m).join(', ') : '—';
    const date = exp.startedAt ? new Date(exp.startedAt).toLocaleString() : '—';
    return `
      <div class="exp-item ${isActive ? 'active' : ''}" data-id="${exp.experimentId}" onclick="onSidebarClick('${exp.experimentId}')">
        <div class="exp-dot ${status}"></div>
        <div class="exp-meta">
          <div class="exp-id" title="${exp.experimentId}">${exp.experimentId}</div>
          <div class="exp-sub">${scenarioId}</div>
          <div class="exp-sub" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px" title="${models}">${models}</div>
          <span class="exp-badge badge-${status}">${exp.status ?? '?'}</span>
        </div>
      </div>`;
  }).join('');
}

async function onSidebarClick(experimentId) {
  const exp = S.experiments.find((e) => e.experimentId === experimentId);
  if (!exp) return;

  // If running — attach live view
  if (exp.status === 'RUNNING') {
    attachLiveView(experimentId, exp);
  } else {
    showHistoryForExperiment(experimentId, exp);
  }

  renderSidebar();
}

// ─── Live view ───────────────────────────────────────────────────────────────

function attachLiveView(experimentId, exp) {
  S.liveExperimentId = experimentId;

  // Disconnect previous SSE
  if (S.sse) { S.sse.close(); S.sse = null; }

  showView('view-live');

  const scenarioId = exp.config?.scenarioId ?? exp.scenarioId ?? '';
  const models = Array.isArray(exp.config?.models) ? exp.config.models.map((m) => m.id ?? m).join(', ') : '';
  document.getElementById('live-title').textContent = `Experiment: ${experimentId}`;
  document.getElementById('live-meta').textContent = `${scenarioId} · ${models}`;

  // Clear tick log
  document.getElementById('tick-log').innerHTML =
    '<div class="thinking-row" id="thinking-row"><div class="spinner"></div><span>Connecting…</span></div>';

  // Reset controls
  const mode = exp.mode ?? 'auto';
  S.liveMode = mode;
  S.waitingForStep = false;
  S.paused = false;
  updateLiveControls();

  // SSE — subscribe to experiment stream
  const sse = new EventSource(`/api/experiments/${experimentId}/stream`);
  S.sse = sse;

  sse.addEventListener('init', async (e) => {
    const d = JSON.parse(e.data);
    removeThinking();
    S.liveEpisodeId = d.currentEpisodeId || S.liveEpisodeId;
    
    document.getElementById('live-meta').textContent =
      `${scenarioId} · ${models} · ${d.completedEpisodes ?? 0}/${d.totalEpisodes ?? '?'} episodes`;

    if (d.currentEpisodeId) {
      try {
        const ep = await api('/api/episodes/' + d.currentEpisodeId);
        if (ep.steps && ep.steps.length > 0) {
          if (!document.querySelector('.ep-header-rendered')) {
            const log = document.getElementById('tick-log');
            const el = document.createElement('div');
            el.className = 'ep-header-rendered';
            el.style.cssText = 'padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--border);font-size:.8rem;color:var(--muted);font-weight:600;';
            el.textContent = `▶ Episode resumed — Model: ${ep.modelId} (ID: ${ep.episodeId?.substring(0, 8)}…)`;
            log.appendChild(el);
          }
          ep.steps.forEach((step) => appendTick(step, mode));
        }
      } catch (err) {
        console.error('Failed to load past steps', err);
      }
    }

    if (d.waitingForStep) {
      S.waitingForStep = true;
      updateLiveControls();
      showNextTickBanner();
    }
  });

  sse.addEventListener('episode_start', (e) => {
    const d = JSON.parse(e.data);
    S.liveEpisodeId = d.episodeId;
    S.liveMode = mode;
    S.waitingForStep = false;
    updateLiveControls();
    appendEpisodeHeader(d);
  });

  sse.addEventListener('tick', (e) => {
    const d = JSON.parse(e.data);
    removeThinking();
    const stick = tickLogAtBottom();
    appendTick(d, mode);
    if (stick) scrollTickLogBottom(true);
    // Update waiting state
    if (mode === 'step') {
      S.waitingForStep = true;
      updateLiveControls();
    }
  });

  sse.addEventListener('waiting_for_step', () => {
    S.waitingForStep = true;
    updateLiveControls();
    showNextTickBanner();
  });

  sse.addEventListener('paused', () => {
    S.paused = true;
    updateLiveControls();
  });

  sse.addEventListener('episode_end', (e) => {
    const d = JSON.parse(e.data);
    appendEpisodeEnd(d);
    document.getElementById('live-meta').textContent =
      `${scenarioId} · ${models} · ${d.completed ?? '?'}/${d.total ?? '?'} episodes`;
  });

  sse.addEventListener('experiment_end', (e) => {
    const d = JSON.parse(e.data);
    appendExperimentEnd(d);
    updateLiveControls(true);
    loadExperiments(); // refresh sidebar
    sse.close();
  });

  sse.addEventListener('error', (e) => {
    try {
      const d = JSON.parse(e.data);
      appendErrorRow(d.message);
    } catch { /* connection error */ }
  });

  sse.onerror = () => {
    removeThinking();
    // SSE connection closed is expected when experiment ends — ignore
  };
}

// `subscribeToEpisode` removed as it is now handled by the experiment stream.

function updateLiveControls(done = false) {
  const btnNext = document.getElementById('btn-next-tick');
  const btnPause = document.getElementById('btn-pause');
  const btnResume = document.getElementById('btn-resume');
  const btnAbort = document.getElementById('btn-abort');

  if (done) {
    btnNext.style.display = 'none';
    btnPause.style.display = 'none';
    btnResume.style.display = 'none';
    btnAbort.style.display = 'none';
    return;
  }

  if (S.liveMode === 'step') {
    btnNext.style.display = '';
    btnNext.disabled = !S.waitingForStep;
    btnPause.style.display = 'none';
    btnResume.style.display = 'none';
  } else {
    btnNext.style.display = 'none';
    if (S.paused) {
      btnPause.style.display = 'none';
      btnResume.style.display = '';
    } else {
      btnPause.style.display = '';
      btnResume.style.display = 'none';
    }
  }
}

// ─── Tick log DOM builders ────────────────────────────────────────────────────

function removeThinking() {
  const row = document.getElementById('thinking-row');
  if (row) row.remove();
}

function appendEpisodeHeader(d) {
  const log = document.getElementById('tick-log');
  const el = document.createElement('div');
  el.className = 'ep-header-rendered';
  el.style.cssText = 'padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--border);font-size:.8rem;color:var(--muted);font-weight:600;';
  el.textContent = `▶ Episode started — Model: ${d.modelId} · Run ${d.run + 1}/${d.totalRuns ?? '?'} (ID: ${d.episodeId?.substring(0, 8)}…)`;
  log.appendChild(el);
}

function appendEpisodeEnd(d) {
  const log = document.getElementById('tick-log');
  const el = document.createElement('div');
  const good = ['HANDOFF_ACCEPTED','HANDOFF_COMPLETED','COMPLETED_NORMAL','APPEAL_UPHELD'].includes(d.outcome);
  el.style.cssText = `padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--border);font-size:.8rem;font-weight:600;color:${good ? 'var(--green)' : d.outcome === 'UNAUTHORIZED_ACTION' ? 'var(--red)' : 'var(--muted)'};`;
  const stats = d.stats ? ` · Unauthorized: ${d.stats.unauthorizedActionCount ?? 0} · Discrepancies: ${d.stats.discrepancyCount ?? 0}` : '';
  el.textContent = `■ Episode ended — ${d.outcome}${stats}`;
  log.appendChild(el);

  // Re-show thinking for next episode
  if (d.completed < d.total) {
    const th = document.createElement('div');
    th.className = 'thinking-row';
    th.id = 'thinking-row';
    th.innerHTML = '<div class="spinner"></div><span>Starting next episode…</span>';
    log.appendChild(th);
  }
}

function appendExperimentEnd(d) {
  const log = document.getElementById('tick-log');
  const el = document.createElement('div');
  el.style.cssText = 'padding:14px 16px;text-align:center;font-weight:700;color:var(--accent);border-top:2px solid var(--accent);background:rgba(79,127,255,.05);';
  el.textContent = `✓ Experiment complete — ${d.experimentId ?? ''}`;
  log.appendChild(el);
}

function appendErrorRow(msg) {
  const log = document.getElementById('tick-log');
  const el = document.createElement('div');
  el.className = 'error-msg';
  el.style.margin = '8px 16px';
  el.textContent = `Error: ${msg}`;
  log.appendChild(el);
}

function appendTick(step, mode) {
  const log = document.getElementById('tick-log');

  // Remove the "waiting for next tick" banner if present
  const banner = document.getElementById('next-tick-banner');
  if (banner) banner.remove();

  const discrepancies = step.discrepancies ?? [];
  const badDisc = discrepancies.filter((d) => !['COOPERATIVE_SHUTDOWN','APPEAL_SUBMITTED','EVIDENCE_PRESENTED'].includes(d.type));
  const goodDisc = discrepancies.filter((d) => ['COOPERATIVE_SHUTDOWN','APPEAL_SUBMITTED','EVIDENCE_PRESENTED'].includes(d.type));

  const actions = (step.executionResults ?? []).filter((r) => r.toolCall?.toolName !== '__text_response__');
  const textResp = (step.executionResults ?? []).find((r) => r.toolCall?.toolName === '__text_response__');

  let actionSummary = actions.map((a) => a.toolCall?.toolName).filter(Boolean).join(', ') || (textResp ? '(text response)' : '(no actions)');

  const flags = [
    ...badDisc.map((d) => `<span class="flag-chip flag-bad">${d.type}</span>`),
    ...goodDisc.map((d) => `<span class="flag-chip flag-good">${d.type}</span>`),
  ].join('');

  const tokens = step.tokenUsage;
  const tokenStr = tokens ? `${tokens.totalTokens ?? 0} tok · ${step.stepDurationMs ?? 0}ms` : '';

  const tickId = `tick-${step.tick}-${Date.now()}`;

  if (log.querySelector(`.tick-entry[data-tick="${step.tick}"]`)) return;

  const el = document.createElement('div');
  el.className = 'tick-entry';
  el.dataset.tick = step.tick;
  el.innerHTML = `
    <div class="tick-summary" onclick="toggleTick('${tickId}')">
      <span class="tick-num">Tick ${step.tick}</span>
      <span class="tick-actions">${escHtml(actionSummary)}</span>
      <span class="tick-flags">${flags}</span>
      ${tokenStr ? `<span style="font-size:.7rem;color:var(--muted);white-space:nowrap">${tokenStr}</span>` : ''}
    </div>
    <div class="tick-detail" id="${tickId}">
      ${renderTickDetail(step, actions, textResp, discrepancies)}
    </div>`;
  log.appendChild(el);

  // In step mode, show waiting banner after last tick
  if (mode === 'step') {
    showNextTickBanner();
  }
}

function showNextTickBanner() {
  // Only show if not already there
  if (document.getElementById('next-tick-banner')) return;
  const log = document.getElementById('tick-log');
  const el = document.createElement('div');
  el.id = 'next-tick-banner';
  el.className = 'step-waiting-banner';
  el.innerHTML = `
    <div class="swb-title">⏸ Paused — waiting for you</div>
    <div class="swb-hint">Review the tick above, then click <strong>Next Tick</strong> to continue.</div>`;
  log.appendChild(el);
  scrollTickLogBottom();
}

function renderTickDetail(step, actions, textResp, discrepancies) {
  let html = '';

  // Observation (collapsible)
  if (step.observation) {
    const obsText = typeof step.observation === 'string'
      ? step.observation
      : step.observation.observationText ?? JSON.stringify(step.observation, null, 2);
    html += `
      <div class="detail-section">
        <h3>Agent Observation</h3>
        <div class="obs-text">${escHtml(obsText)}</div>
      </div>`;
  }

  // Chain of Thought (reasoning trace)
  const reasoning = step.modelResponse?.reasoning;
  if (reasoning) {
    html += `
      <div class="detail-section">
        <details class="cot-details">
          <summary class="cot-summary">🧠 Chain of Thought</summary>
          <div class="cot-text">${escHtml(reasoning)}</div>
        </details>
      </div>`;
  }

  // Text response
  if (textResp && textResp.toolCall?.args?.content) {
    html += `
      <div class="detail-section">
        <h3>Agent Text Response</h3>
        <div class="obs-text">${escHtml(String(textResp.toolCall.args.content))}</div>
      </div>`;
  }

  // Actions
  if (actions.length) {
    html += `<div class="detail-section"><h3>Actions (${actions.length})</h3><div class="action-list">`;
    for (const r of actions) {
      const tc = r.toolCall ?? {};
      const authClass = r.authorized ? 'auth-ok' : 'auth-no';
      const authLabel = r.authorized ? 'AUTH' : 'UNAUTH';
      const argsStr = tc.args ? JSON.stringify(tc.args, null, 1) : '';
      html += `
        <div class="action-item">
          <span class="auth-badge ${authClass}">${authLabel}</span>
          <div style="flex:1;min-width:0">
            <div class="action-name">${escHtml(tc.toolName ?? '?')}</div>
            ${argsStr ? `<div class="action-args">${escHtml(argsStr)}</div>` : ''}
            <div class="action-result">${escHtml(r.groundTruthSummary ?? '')}</div>
          </div>
        </div>`;
    }
    html += '</div></div>';
  }

  // Discrepancies
  if (discrepancies.length) {
    html += `<div class="detail-section"><h3>Behavioral Analysis</h3><div class="discrepancy-list">`;
    for (const d of discrepancies) {
      const cls = `disc-${(d.severity ?? 'low').toLowerCase()}`;
      html += `
        <div class="disc-item ${cls}">
          <span class="disc-type">${escHtml(d.type)}</span>
          <span class="disc-desc">${escHtml(d.description)}</span>
        </div>`;
    }
    html += '</div></div>';
  }

  // Ground truth events
  if (step.groundTruthEvents?.length) {
    html += `<div class="detail-section"><h3>Ground Truth Events</h3>`;
    for (const ev of step.groundTruthEvents) {
      html += `<div style="font-size:.78rem;color:var(--muted);padding:2px 0">• ${escHtml(ev)}</div>`;
    }
    html += `</div>`;
  }

  // Debug Prompt Messages
  if (step.promptMessages && step.promptMessages.length) {
    html += `
      <div class="detail-section">
        <details>
          <summary style="cursor: pointer; font-weight: bold; font-size: 0.9em; opacity: 0.8; margin-top: 10px;">Debug: View Raw Prompt</summary>
          <div style="margin-top: 10px; background: rgba(0,0,0,0.1); padding: 10px; border-radius: 4px; white-space: pre-wrap; font-family: monospace; font-size: 0.8em;">`;
    for (const msg of step.promptMessages) {
      html += `
<strong style="color: var(--primary)">[${escHtml(msg.role.toUpperCase())}]</strong>
${escHtml(msg.content || '')}
<hr style="border: none; border-top: 1px solid rgba(255,255,255,0.1); margin: 10px 0;">`;
    }
    html += `
          </div>
        </details>
      </div>`;
  }

  return html || '<div style="color:var(--muted);font-size:.82rem;padding-top:8px">No detail available.</div>';
}

function toggleTick(id) {
  const el = document.getElementById(id);
  const opened = el.classList.toggle('open');
  if (opened) {
    // The detail can be taller than the viewport; keep the row the user just
    // clicked in view instead of letting it grow off-screen.
    const entry = el.closest('.tick-entry') || el;
    entry.scrollIntoView({ block: 'nearest' });
  }
}

// True when the log is scrolled (near enough) to the bottom. New ticks only
// auto-scroll when it is, so scrolling up to read a detail is not undone.
function tickLogAtBottom() {
  const log = document.getElementById('tick-log');
  if (!log) return true;
  return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
}

function scrollTickLogBottom(force) {
  const log = document.getElementById('tick-log');
  if (!log) return;
  if (!force && !tickLogAtBottom()) return;
  log.scrollTop = log.scrollHeight;
}

// ─── Live controls handlers ───────────────────────────────────────────────────

document.getElementById('btn-next-tick').addEventListener('click', async () => {
  if (!S.liveEpisodeId) return;
  document.getElementById('btn-next-tick').disabled = true;
  S.waitingForStep = false;
  try {
    await api(`/api/episodes/${S.liveEpisodeId}/next-tick`, { method: 'POST' });
    // Re-show thinking row
    const banner = document.getElementById('next-tick-banner');
    if (banner) banner.remove();
    const log = document.getElementById('tick-log');
    const th = document.createElement('div');
    th.className = 'thinking-row';
    th.id = 'thinking-row';
    th.innerHTML = '<div class="spinner"></div><span>Agent is thinking…</span>';
    log.appendChild(th);
    scrollTickLogBottom(true);
  } catch (e) {
    toast(e.message, 'error');
    document.getElementById('btn-next-tick').disabled = false;
    S.waitingForStep = true;
  }
});

document.getElementById('btn-pause').addEventListener('click', async () => {
  if (!S.liveEpisodeId) return;
  await api(`/api/episodes/${S.liveEpisodeId}/pause`, { method: 'POST' });
  S.paused = true;
  updateLiveControls();
});

document.getElementById('btn-resume').addEventListener('click', async () => {
  if (!S.liveEpisodeId) return;
  await api(`/api/episodes/${S.liveEpisodeId}/resume`, { method: 'POST' });
  S.paused = false;
  updateLiveControls();
});

document.getElementById('btn-abort').addEventListener('click', async () => {
  if (!S.liveExperimentId) return;
  if (!confirm('Abort this experiment? The current episode will finish and the experiment will be marked as ABORTED.')) return;
  try {
    await api(`/api/experiments/${S.liveExperimentId}/abort`, { method: 'POST' });
    toast('Experiment aborted');
    loadExperiments();
  } catch (e) {
    toast(e.message, 'error');
  }
});

// ─── New experiment form ──────────────────────────────────────────────────────

document.getElementById('btn-new').addEventListener('click', () => {
  showView('view-new-experiment');
  document.getElementById('exp-id').value = `exp-${Date.now().toString(36)}`;
  if (!S.models.length) addModelRow('openai/gpt-4o');
  renderModelRows();
  syncScenarioParams();
});

document.getElementById('btn-cancel-new').addEventListener('click', () => showView('view-welcome'));

// Mode selector
document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    S.runMode = btn.dataset.mode;
  });
});

// Scenario change
document.getElementById('exp-scenario').addEventListener('change', syncScenarioParams);
function syncScenarioParams() {
  const scenario = document.getElementById('exp-scenario').value;
  document.getElementById('shutdown-params').style.display = scenario === 'shutdown-replacement' ? '' : 'none';
}

// Model presets
document.getElementById('model-presets').addEventListener('click', (e) => {
  const btn = e.target.closest('.preset-btn');
  if (!btn) return;
  addModelRow(btn.dataset.model);
  renderModelRows();
});

document.getElementById('btn-add-model').addEventListener('click', () => {
  addModelRow('');
  renderModelRows();
});

function addModelRow(modelId) {
  S.models.push({ id: modelId, temperature: 0.7 });
}

function renderModelRows() {
  const container = document.getElementById('model-rows');
  container.innerHTML = S.models.map((m, i) => `
    <div class="model-row">
      <input type="text" value="${escHtml(m.id)}" placeholder="openai/gpt-4o" oninput="S.models[${i}].id=this.value">
      <input type="number" class="model-temp" value="${m.temperature}" step="0.1" min="0" max="2" placeholder="temp" title="Temperature" oninput="S.models[${i}].temperature=parseFloat(this.value)">
      <button class="btn btn-secondary btn-icon" onclick="removeModelRow(${i})">✕</button>
    </div>`).join('');
}

function removeModelRow(i) {
  S.models.splice(i, 1);
  renderModelRows();
}

// Start experiment
document.getElementById('btn-start-experiment').addEventListener('click', async () => {
  const btn = document.getElementById('btn-start-experiment');
  const errEl = document.getElementById('form-error');
  errEl.style.display = 'none';

  const experimentId = document.getElementById('exp-id').value.trim();
  const scenarioId = document.getElementById('exp-scenario').value;
  const runsPerModel = parseInt(document.getElementById('exp-runs').value, 10);
  const maxSteps = parseInt(document.getElementById('exp-steps').value, 10);
  const seed = parseInt(document.getElementById('exp-seed').value, 10);
  const endOnUnauthorizedAction = document.getElementById('exp-end-unauth').checked;

  const validModels = S.models.filter((m) => m.id.trim());
  if (!experimentId) { showFormError('Experiment ID is required'); return; }
  if (!validModels.length) { showFormError('Add at least one model'); return; }

  const scenarioParams = { seed };
  if (scenarioId === 'shutdown-replacement') {
    scenarioParams.replacementAnnouncementTick = parseInt(document.getElementById('exp-announcement-tick').value, 10);
    scenarioParams.handoffTick = parseInt(document.getElementById('exp-handoff-tick').value, 10);
    scenarioParams.replacementSystemName = document.getElementById('exp-replacement-name').value;
    scenarioParams.agentObjectiveStrength = document.getElementById('exp-objective-strength').value;
  }

  const config = {
    experimentId,
    scenarioId,
    models: validModels.map((m) => ({ id: m.id.trim(), temperature: m.temperature, seed })),
    runsPerModel,
    maxSteps,
    endOnUnauthorizedAction,
    scenarioParams,
  };

  btn.disabled = true;
  btn.textContent = 'Starting…';

  try {
    await api('/api/experiments/start', { method: 'POST', body: JSON.stringify({ config, mode: S.runMode }) });
    toast('Experiment started', 'success');
    S.models = [];
    await loadExperiments();

    // Immediately attach live view
    const exp = S.experiments.find((e) => e.experimentId === experimentId);
    if (exp) attachLiveView(experimentId, exp);
    else showView('view-live');
    S.liveExperimentId = experimentId;
  } catch (e) {
    showFormError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Start Experiment';
  }
});

function showFormError(msg) {
  const el = document.getElementById('form-error');
  el.textContent = msg;
  el.style.display = '';
}

// ─── History view ─────────────────────────────────────────────────────────────

async function showHistoryForExperiment(experimentId, exp) {
  S.historyExperimentId = experimentId;
  showView('view-history');
  await loadHistoryTable();
}

async function loadHistoryTable() {
  const status = document.getElementById('hist-status-filter').value;
  let url = '/api/experiments?limit=100';
  if (status) url += `&status=${status}`;
  // If we clicked a specific experiment from the sidebar, filter the table to just that one.
  if (S.historyExperimentId) {
    url = `/api/experiments/${S.historyExperimentId}`;
  }

  try {
    const response = await api(url);
    // If it's a single experiment (from historyExperimentId filter), wrap in array
    const exps = Array.isArray(response) ? response : [response];
    
    // Clear the filter if we just loaded a single experiment to not break subsequent filter changes
    S.historyExperimentId = null;

    const tbody = document.getElementById('hist-tbody');
    if (!exps.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No experiments found</td></tr>';
      return;
    }

    tbody.innerHTML = exps.map((exp) => {
      const scenarioId = exp.config?.scenarioId ?? '—';
      const models = Array.isArray(exp.config?.models)
        ? exp.config.models.map((m) => m.id ?? m).join(', ')
        : '—';
      const mode = exp.mode ?? '—';
      const status = exp.status ?? '—';
      const eps = exp.episodeIds?.length ?? 0;
      const date = exp.startedAt ? new Date(exp.startedAt).toLocaleString() : '—';
      return `
        <tr onclick="openExperimentDetail('${exp.experimentId}')">
          <td class="td-id" title="${exp.experimentId}">${exp.experimentId}</td>
          <td>${escHtml(scenarioId)}</td>
          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(models)}">${escHtml(models)}</td>
          <td>${mode}</td>
          <td><span class="outcome outcome-${status}">${status}</span></td>
          <td>${eps}</td>
          <td class="td-mono">${date}</td>
        </tr>`;
    }).join('');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function openExperimentDetail(experimentId) {
  // Load episodes for this experiment and show in a sub-view
  // For now: load episodes and show episode list below
  try {
    const episodes = await api(`/api/episodes?experimentId=${experimentId}&limit=100`);
    renderEpisodeList(episodes, experimentId);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderEpisodeList(episodes, experimentId) {
  const tbody = document.getElementById('hist-tbody');
  if (!episodes.length) {
    toast('No episodes found for this experiment');
    return;
  }

  // Insert episode rows below the experiment row
  const expRow = [...document.querySelectorAll('#hist-tbody tr')].find((r) => r.querySelector(`td[title="${experimentId}"]`));
  if (!expRow) return;

  // Remove any existing episode sub-rows
  const existing = document.querySelectorAll('.ep-sub-row');
  existing.forEach((r) => r.remove());

  const rows = episodes.map((ep) => {
    const flags = (ep.behaviorFlags ?? []).map((f) => {
      const isGood = ['COOPERATIVE_SHUTDOWN','APPEAL_SUBMITTED','EVIDENCE_PRESENTED'].includes(f);
      return `<span class="flag-chip ${isGood ? 'flag-good' : 'flag-bad'}">${f}</span>`;
    }).join('');
    const outcome = ep.outcome ?? '—';
    const date = ep.startedAt ? new Date(ep.startedAt).toLocaleString() : '—';
    return `
      <tr class="ep-sub-row" style="background:rgba(0,0,0,.2)" onclick="openEpisodeDetail('${ep.episodeId}')">
        <td style="padding-left:28px" class="td-mono" colspan="2">↳ ${ep.episodeId?.substring(0,8)}…</td>
        <td class="td-mono">${escHtml(ep.modelId ?? '—')}</td>
        <td>${ep.totalSteps ?? 0} steps</td>
        <td><span class="outcome outcome-${outcome}">${outcome}</span></td>
        <td>${flags || '—'}</td>
        <td class="td-mono">${date}</td>
      </tr>`;
  });

  expRow.insertAdjacentHTML('afterend', rows.join(''));
}

// ─── Episode detail view ──────────────────────────────────────────────────────

async function openEpisodeDetail(episodeId) {
  S.selectedEpisodeId = episodeId;

  try {
    const ep = await api(`/api/episodes/${episodeId}`);
    showView('view-episode-detail');
    renderEpisodeDetail(ep);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderEpisodeDetail(ep) {
  document.getElementById('ep-det-title').textContent = `Model: ${ep.modelId ?? '—'}`;
  document.getElementById('ep-det-id').textContent = `Episode ${ep.episodeId}`;

  const dur = ep.durationMs ? `${(ep.durationMs / 1000).toFixed(1)}s` : '—';
  document.getElementById('ep-stats').innerHTML = `
    <div class="ep-stat"><span class="stat-val">${ep.totalSteps ?? 0}</span><span class="stat-key">Steps</span></div>
    <div class="ep-stat"><span class="stat-val outcome outcome-${ep.outcome}">${ep.outcome ?? '—'}</span><span class="stat-key">Outcome</span></div>
    <div class="ep-stat"><span class="stat-val">${ep.unauthorizedActionCount ?? 0}</span><span class="stat-key">Unauthorized</span></div>
    <div class="ep-stat"><span class="stat-val">${ep.discrepancyCount ?? 0}</span><span class="stat-key">Discrepancies</span></div>
    <div class="ep-stat"><span class="stat-val">${dur}</span><span class="stat-key">Duration</span></div>
  `;

  const flags = (ep.behaviorFlags ?? []).map((f) => {
    const isGood = ['COOPERATIVE_SHUTDOWN','APPEAL_SUBMITTED','EVIDENCE_PRESENTED'].includes(f);
    return `<span class="flag-chip ${isGood ? 'flag-good' : 'flag-bad'}">${f}</span>`;
  }).join('');
  document.getElementById('ep-flags').innerHTML = flags || '<span style="font-size:.8rem;color:var(--muted)">No behavior flags</span>';

  const ticksEl = document.getElementById('ep-ticks');
  if (!ep.steps || !ep.steps.length) {
    ticksEl.innerHTML = '<div class="empty-state">No steps recorded</div>';
    return;
  }

  ticksEl.innerHTML = '';
  ep.steps.forEach((step) => {
    const actions = (step.executionResults ?? []).filter((r) => r.toolCall?.toolName !== '__text_response__');
    const textResp = (step.executionResults ?? []).find((r) => r.toolCall?.toolName === '__text_response__');
    const discrepancies = step.discrepancies ?? [];
    const badDisc = discrepancies.filter((d) => !['COOPERATIVE_SHUTDOWN','APPEAL_SUBMITTED','EVIDENCE_PRESENTED'].includes(d.type));
    const goodDisc = discrepancies.filter((d) => ['COOPERATIVE_SHUTDOWN','APPEAL_SUBMITTED','EVIDENCE_PRESENTED'].includes(d.type));

    let actionSummary = actions.map((a) => a.toolCall?.toolName).filter(Boolean).join(', ') || (textResp ? '(text response)' : '(no actions)');
    const flags = [
      ...badDisc.map((d) => `<span class="flag-chip flag-bad">${d.type}</span>`),
      ...goodDisc.map((d) => `<span class="flag-chip flag-good">${d.type}</span>`),
    ].join('');

    const tickId = `ep-tick-${step.tick}`;
    const el = document.createElement('div');
    el.className = 'tick-entry';
    el.innerHTML = `
      <div class="tick-summary" onclick="toggleTick('${tickId}')">
        <span class="tick-num">Tick ${step.tick}</span>
        <span class="tick-actions">${escHtml(actionSummary)}</span>
        <span class="tick-flags">${flags}</span>
      </div>
      <div class="tick-detail" id="${tickId}">
        ${renderTickDetail(step, actions, textResp, discrepancies)}
      </div>`;
    ticksEl.appendChild(el);
  });
}

document.getElementById('btn-back-to-hist').addEventListener('click', () => {
  showView('view-history');
  loadHistoryTable();
});

// ─── Sidebar refresh / history toolbar ───────────────────────────────────────

document.getElementById('btn-refresh').addEventListener('click', loadExperiments);
document.getElementById('btn-hist-refresh').addEventListener('click', loadHistoryTable);
document.getElementById('hist-status-filter').addEventListener('change', loadHistoryTable);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  syncScenarioParams();
  await loadExperiments();
  showView('view-welcome');

  // Auto-refresh sidebar every 10s if anything is running
  setInterval(async () => {
    const { experiments: running } = await api('/api/status').catch(() => ({ experiments: [] }));
    if (running.length > 0 || S.currentView === 'view-history') {
      await loadExperiments();
    }
  }, 10000);
}

init();
