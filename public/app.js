const state = {
  token: localStorage.getItem('bridgeApiToken') || '',
  jobs: [],
  selectedJobId: '',
  logOffset: 0,
  events: null,
  pollTimer: null
};

const els = {
  serviceStatus: document.getElementById('serviceStatus'),
  authForm: document.getElementById('authForm'),
  tokenInput: document.getElementById('tokenInput'),
  refreshButton: document.getElementById('refreshButton'),
  createJobForm: document.getElementById('createJobForm'),
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
  cancelButton: document.getElementById('cancelButton'),
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

function appendLogLine(line) {
  const shouldPin = els.logOutput.scrollTop + els.logOutput.clientHeight >= els.logOutput.scrollHeight - 32;
  els.logOutput.textContent += `${lineText(line)}\n`;
  if (shouldPin) {
    els.logOutput.scrollTop = els.logOutput.scrollHeight;
  }
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
    els.cancelButton.disabled = true;
    return;
  }

  els.selectedTitle.textContent = job.commandDisplay || job.commandKey || job.id;
  els.selectedMeta.textContent = `${job.id} - ${job.repoRoot || job.repoPath || ''}`;
  els.followButton.disabled = false;
  els.cancelButton.disabled = !['queued', 'running'].includes(job.status);
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
  const data = await api(`/jobs/${encodeURIComponent(jobId)}/logs?offset=0&limit=5000`);
  els.logOutput.textContent = '';
  for (const line of data.lines || []) {
    appendLogLine(line);
  }
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
  state.events.onmessage = (event) => appendLogLine(JSON.parse(event.data));
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

async function cancelSelected() {
  if (!state.selectedJobId) return;
  await api(`/jobs/${encodeURIComponent(state.selectedJobId)}/cancel`, {
    method: 'POST'
  });
  await loadJobs();
}

function parseArgs(value) {
  return String(value || '')
    .split(' ')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function createJob(event) {
  event.preventDefault();
  const data = new FormData(els.createJobForm);
  const body = {
    repoPath: String(data.get('repoPath') || '').trim(),
    commandKey: String(data.get('commandKey') || '').trim(),
    repoRef: String(data.get('repoRef') || '').trim(),
    args: parseArgs(data.get('args'))
  };

  const result = await api('/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  await loadJobs();
  await selectJob(result.job.id);
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
els.cancelButton.addEventListener('click', () => {
  cancelSelected().catch((error) => setStreamState(error.message));
});
els.createJobForm.addEventListener('submit', (event) => {
  createJob(event).catch((error) => {
    els.serviceStatus.textContent = error.message;
  });
});

loadHealth().catch((error) => {
  els.serviceStatus.textContent = error.message;
});
loadJobs().catch((error) => {
  els.serviceStatus.textContent = error.message;
});
startPolling();
