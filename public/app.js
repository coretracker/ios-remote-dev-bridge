const state = {
  token: localStorage.getItem('bridgeApiToken') || '',
  jobs: [],
  selectedJobId: '',
  logOffset: 0,
  logLineCount: 0,
  pendingLogText: '',
  pendingLogLines: 0,
  pendingLogFrame: null,
  logChunks: [],
  events: null,
  pollTimer: null
};

const LOG_RENDER_LIMIT = 1200;
const LOG_SNAPSHOT_LIMIT = 800;

const els = {
  serviceStatus: document.getElementById('serviceStatus'),
  authForm: document.getElementById('authForm'),
  tokenInput: document.getElementById('tokenInput'),
  refreshButton: document.getElementById('refreshButton'),
  jobsList: document.getElementById('jobsList'),
  jobCount: document.getElementById('jobCount'),
  metricRunning: document.getElementById('metricRunning'),
  metricQueued: document.getElementById('metricQueued'),
  metricPassed: document.getElementById('metricPassed'),
  metricFailed: document.getElementById('metricFailed'),
  selectedTitle: document.getElementById('selectedTitle'),
  selectedMeta: document.getElementById('selectedMeta'),
  jobSummary: document.getElementById('jobSummary'),
  followButton: document.getElementById('followButton'),
  streamState: document.getElementById('streamState'),
  logOutput: document.getElementById('logOutput')
};

els.tokenInput.value = state.token;

function authHeaders(extra = {}) {
  return state.token
    ? { ...extra, Authorization: `Bearer ${state.token}` }
    : extra;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: authHeaders(options.headers || {})
  });

  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      message = body.error || message;
    } catch {
      // Keep the status text.
    }
    throw new Error(message);
  }

  return response.json();
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

function shortId(id) {
  return id ? id.replace(/^job_/, '').slice(0, 8) : '-';
}

function lineText(line) {
  return `[${line.ts}] [${line.stream}] ${line.message}`;
}

function setStreamState(value) {
  els.streamState.textContent = value;
}

function scrollLogsToBottom() {
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}

function pruneLogOutput() {
  while (state.logLineCount > LOG_RENDER_LIMIT && state.logChunks.length > 1) {
    const chunk = state.logChunks.shift();
    chunk.node.remove();
    state.logLineCount -= chunk.lineCount;
  }
}

function trimLogText(text, lineCount) {
  if (lineCount <= LOG_RENDER_LIMIT) {
    return { text, lineCount };
  }

  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  const kept = lines.slice(-LOG_RENDER_LIMIT);
  return {
    text: `${kept.join('\n')}\n`,
    lineCount: kept.length
  };
}

function flushPendingLogs() {
  state.pendingLogFrame = null;

  if (!state.pendingLogText) {
    return;
  }

  const pending = trimLogText(state.pendingLogText, state.pendingLogLines);
  if (pending.lineCount >= LOG_RENDER_LIMIT) {
    state.logChunks = [];
    state.logLineCount = 0;
    els.logOutput.textContent = '';
  }

  const node = document.createTextNode(pending.text);
  els.logOutput.append(node);
  state.logChunks.push({
    node,
    lineCount: pending.lineCount
  });
  state.logLineCount += pending.lineCount;
  state.pendingLogText = '';
  state.pendingLogLines = 0;

  pruneLogOutput();
  scrollLogsToBottom();
}

function queueLogText(text, lineCount) {
  state.pendingLogText += text;
  state.pendingLogLines += lineCount;

  if (state.pendingLogFrame === null) {
    state.pendingLogFrame = requestAnimationFrame(flushPendingLogs);
  }
}

function resetLogOutput() {
  if (state.pendingLogFrame !== null) {
    cancelAnimationFrame(state.pendingLogFrame);
  }

  state.pendingLogFrame = null;
  state.pendingLogText = '';
  state.pendingLogLines = 0;
  state.logLineCount = 0;
  state.logChunks = [];
  els.logOutput.textContent = '';
}

function appendLogLine(line) {
  queueLogText(`${lineText(line)}\n`, 1);
}

function appendLogLines(lines) {
  if (!lines.length) {
    return;
  }

  queueLogText(`${lines.map(lineText).join('\n')}\n`, lines.length);
}

function renderMetrics(metrics = {}) {
  els.metricRunning.textContent = metrics.running || 0;
  els.metricQueued.textContent = metrics.queued || 0;
  els.metricPassed.textContent = metrics.passed || 0;
  els.metricFailed.textContent = metrics.failed || 0;
}

function renderJobs() {
  els.jobCount.textContent = `${state.jobs.length} ${state.jobs.length === 1 ? 'job' : 'jobs'}`;
  els.jobsList.innerHTML = '';

  if (!state.jobs.length) {
    const empty = document.createElement('p');
    empty.className = 'job-sub';
    empty.textContent = 'No jobs yet.';
    els.jobsList.append(empty);
    return;
  }

  for (const job of state.jobs) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `job-item${job.id === state.selectedJobId ? ' active' : ''}`;
    item.innerHTML = `
      <div class="job-main">
        <span class="job-command">${escapeHtml(job.commandDisplay || job.commandKey || job.id)}</span>
        <span class="badge ${job.status}">${escapeHtml(job.status)}</span>
      </div>
      <div class="job-sub">${escapeHtml(shortId(job.id))} - ${escapeHtml(job.repoRoot || job.repoPath || '')}</div>
    `;
    item.addEventListener('click', () => selectJob(job.id));
    els.jobsList.append(item);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderSelected(job) {
  if (!job) {
    els.selectedTitle.textContent = 'Select a job';
    els.selectedMeta.textContent = 'Realtime logs appear here.';
    els.jobSummary.innerHTML = '';
    els.followButton.disabled = true;
    return;
  }

  els.selectedTitle.textContent = job.commandDisplay || job.commandKey || job.id;
  els.selectedMeta.textContent = `${job.id} - ${job.repoRoot || job.repoPath || ''}`;
  els.followButton.disabled = false;
  els.jobSummary.innerHTML = `
    <div><strong>${escapeHtml(job.status)}</strong><small>Status</small></div>
    <div><strong>${escapeHtml(formatDuration(job.durationMs))}</strong><small>Duration</small></div>
    <div><strong>${escapeHtml(formatDuration(job.queueWaitMs))}</strong><small>Queue wait</small></div>
    <div><strong>${job.exitCode === null ? '-' : escapeHtml(job.exitCode)}</strong><small>Exit code</small></div>
  `;
}

async function loadHealth() {
  const health = await api('/health');
  els.serviceStatus.textContent = `Service ok - uptime ${formatDuration(health.uptimeMs)}`;
}

async function loadJobs() {
  const data = await api('/jobs');
  state.jobs = data.jobs || [];
  renderMetrics(data.metrics || {});
  renderJobs();
  renderSelected(state.jobs.find((job) => job.id === state.selectedJobId));
}

async function loadSnapshot(jobId) {
  const summary = await api(`/jobs/${encodeURIComponent(jobId)}/logs?offset=0&limit=1`);
  const total = summary.total || 0;
  const offset = Math.max(0, total - LOG_SNAPSHOT_LIMIT);
  const data = await api(`/jobs/${encodeURIComponent(jobId)}/logs?offset=${offset}&limit=${LOG_SNAPSHOT_LIMIT}`);
  resetLogOutput();
  appendLogLines(data.lines || []);
  state.logOffset = data.total || 0;
}

async function selectJob(jobId) {
  state.selectedJobId = jobId;
  const job = await api(`/jobs/${encodeURIComponent(jobId)}`);
  renderSelected(job);
  renderJobs();
  await loadSnapshot(jobId);

  if (['queued', 'running'].includes(job.status)) {
    await followSelected();
  } else {
    closeStream();
    setStreamState('Complete');
  }
}

function closeStream() {
  if (state.events) {
    state.events.close();
    state.events = null;
  }
}

async function followSelected() {
  if (!state.selectedJobId) return;
  closeStream();
  setStreamState('Opening stream...');

  const offset = Math.max(0, state.logOffset || 0);
  let streamUrl = `/jobs/${encodeURIComponent(state.selectedJobId)}/logs?follow=true&offset=${offset}&limit=200`;
  if (state.token) {
    const token = await api(`/jobs/${encodeURIComponent(state.selectedJobId)}/log-stream-token`, {
      method: 'POST'
    });
    streamUrl += `&streamToken=${encodeURIComponent(token.streamToken)}`;
  }

  state.events = new EventSource(streamUrl);
  state.events.onopen = () => setStreamState('Live');
  state.events.onmessage = (event) => {
    appendLogLine(JSON.parse(event.data));
    state.logOffset += 1;
  };
  state.events.addEventListener('done', async () => {
    setStreamState('Complete');
    closeStream();
    await loadJobs();
  });
  state.events.onerror = () => {
    setStreamState('Stream disconnected');
    closeStream();
  };
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    loadHealth().catch((error) => {
      els.serviceStatus.textContent = error.message;
    });
    loadJobs().catch(() => {});
  }, 3000);
}

els.authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  state.token = els.tokenInput.value.trim();
  localStorage.setItem('bridgeApiToken', state.token);
  await loadJobs();
});

els.refreshButton.addEventListener('click', () => {
  loadJobs().catch((error) => {
    els.serviceStatus.textContent = error.message;
  });
});
els.followButton.addEventListener('click', () => {
  followSelected().catch((error) => setStreamState(error.message));
});

loadHealth().catch((error) => {
  els.serviceStatus.textContent = error.message;
});
loadJobs().catch((error) => {
  els.serviceStatus.textContent = error.message;
});
startPolling();
