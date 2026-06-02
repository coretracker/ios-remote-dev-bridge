const express = require('express');
const path = require('path');
const { spawn } = require('child_process');

const { config } = require('./config');
const { JobManager } = require('./job-manager');
const { logEvent } = require('./logger');
const { getCapabilities } = require('./capabilities');
const { generateId, parsePositiveInt } = require('./utils');

const app = express();
const jobManager = new JobManager(config, logEvent);

const serviceStart = Date.now();
const rateBuckets = new Map();
const streamTokens = new Map();

app.use(express.json({ limit: config.requestBodyLimit }));

app.get('/', (req, res) => {
  res.redirect('/ui/');
});

app.use('/ui', express.static(path.join(__dirname, '..', 'public')));

app.use((req, res, next) => {
  const requestId = req.header('x-request-id') || generateId('req');
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  const started = Date.now();
  res.on('finish', () => {
    logEvent('info', 'http_request', {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - started,
      ip: req.ip
    });
  });

  next();
});

app.use((req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/ui')) {
    return next();
  }

  const streamToken = typeof req.query.streamToken === 'string' ? req.query.streamToken : '';
  if (req.path.endsWith('/logs') && streamToken) {
    const token = streamTokens.get(streamToken);
    const jobId = req.path.match(/^\/jobs\/([^/]+)\/logs$/)?.[1] || '';
    if (token && token.jobId === jobId && token.expiresAt > Date.now()) {
      streamTokens.delete(streamToken);
      return next();
    }
  }

  const token = req.header('authorization') || '';
  if (config.disableAuth) {
    return next();
  }

  if (!config.authToken) {
    return res.status(503).json({
      error: 'Service auth token is not configured. Set API_TOKEN or DISABLE_AUTH=true for local-only use.'
    });
  }

  const expected = `Bearer ${config.authToken}`;
  if (token !== expected) {
    return res.status(401).json({
      error: 'Unauthorized. Provide Authorization: Bearer <token>.'
    });
  }

  return next();
});

app.use((req, res, next) => {
  const now = Date.now();
  const subject = req.header('authorization') || req.ip || 'anonymous';

  const bucket = rateBuckets.get(subject) || {
    windowStart: now,
    count: 0
  };

  if (now - bucket.windowStart > config.rateLimitWindowMs) {
    bucket.windowStart = now;
    bucket.count = 0;
  }

  bucket.count += 1;
  rateBuckets.set(subject, bucket);

  if (bucket.count > config.rateLimitMaxRequests) {
    return res.status(429).json({
      error: 'Rate limit exceeded. Slow down and retry.',
      windowMs: config.rateLimitWindowMs,
      maxRequests: config.rateLimitMaxRequests
    });
  }

  return next();
});

function validateJobInput(body) {
  const commandKey = typeof body.commandKey === 'string' ? body.commandKey.trim() : '';
  if (!commandKey) {
    return { ok: false, message: "Missing required field 'commandKey'." };
  }

  const commandKeyPattern = /^[A-Za-z0-9_.:-]+$/;
  if (!config.allowedCommands.includes(commandKey) && !commandKeyPattern.test(commandKey)) {
    return {
      ok: false,
      message: `Command key '${commandKey}' is invalid. Use letters, numbers, '.', '_', ':', or '-'.`
    };
  }

  const repoPath = typeof body.repoPath === 'string' ? body.repoPath.trim() : '';
  if (!repoPath) {
    return { ok: false, message: "Missing required field 'repoPath'." };
  }

  if (body.args !== undefined && !Array.isArray(body.args)) {
    return { ok: false, message: "Field 'args' must be an array of strings." };
  }

  if (body.env !== undefined && (typeof body.env !== 'object' || Array.isArray(body.env) || body.env === null)) {
    return { ok: false, message: "Field 'env' must be an object." };
  }

  const timeoutMsRaw = body.timeoutMs === undefined ? config.defaultTimeoutMs : Number(body.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1_000, Math.min(timeoutMsRaw, config.maxTimeoutMs)) : config.defaultTimeoutMs;

  return {
    ok: true,
    normalized: {
      commandKey,
      args: Array.isArray(body.args) ? body.args.map((item) => String(item)) : [],
      env: body.env || {},
      repoPath,
      repoRef: typeof body.repoRef === 'string' ? body.repoRef.trim() : '',
      timeoutMs,
      deterministic: body.deterministic && typeof body.deterministic === 'object' ? body.deterministic : {},
      idempotencyKey: typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
        ? body.idempotencyKey.trim()
        : ''
    }
  };
}

function statusForError(error) {
  if (!error || !error.code) {
    return 400;
  }

  if (error.code === 'repo_path_missing') {
    return 404;
  }

  if (error.code === 'repo_path_not_directory') {
    return 400;
  }

  return 400;
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'remote-dev-bridge',
    now: new Date().toISOString(),
    uptimeMs: Date.now() - serviceStart,
    concurrency: {
      running: jobManager.getMetrics().running,
      queued: jobManager.getMetrics().queued,
      limit: config.concurrencyLimit
    },
    metrics: jobManager.getMetrics()
  });
});

app.get('/capabilities', async (req, res) => {
  const capabilities = await getCapabilities();
  res.json({
    allowlist: config.allowedCommands,
    allowedExecutables: config.allowedExecutables,
    capabilities
  });
});

app.get('/discover', async (req, res) => {
  const repoPath = typeof req.query.repoPath === 'string' ? req.query.repoPath.trim() : '';
  if (!repoPath) {
    return res.status(400).json({
      error: "Provide query param 'repoPath'."
    });
  }

  try {
    const discovery = await jobManager.discover(repoPath);
    return res.json({
      repoPath: discovery.inputPath,
      repoRoot: discovery.repoRoot,
      repoType: discovery.repoType,
      packageManager: discovery.packageManager,
      commands: discovery.commands,
      missing: discovery.missing,
      missingRecommended: discovery.missingRecommended,
      hints: discovery.hints
    });
  } catch (error) {
    return res.status(statusForError(error)).json({
      error: `Discovery failed: ${error.message}`
    });
  }
});

app.post('/jobs', async (req, res) => {
  const validation = validateJobInput(req.body || {});
  if (!validation.ok) {
    return res.status(400).json({
      error: validation.message
    });
  }

  try {
    const preflight = await jobManager.preflightCommand(
      validation.normalized.commandKey,
      validation.normalized.repoPath
    );

    if (!preflight.ok) {
      return res.status(400).json({
        error: preflight.message,
        commandKey: validation.normalized.commandKey
      });
    }

    const { job, reused } = jobManager.createJob({
      ...validation.normalized,
      requestId: req.requestId
    });

    return res.status(reused ? 200 : 202).json({
      reused,
      job: jobManager.formatJob(job)
    });
  } catch (error) {
    if (error.code === 'idempotency_conflict') {
      return res.status(409).json({ error: error.message });
    }

    return res.status(statusForError(error)).json({ error: error.message });
  }
});

app.get('/jobs', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  const jobs = jobManager.listJobs()
    .filter((job) => !status || job.status === status)
    .sort((a, b) => new Date(b.queuedAt).getTime() - new Date(a.queuedAt).getTime());

  return res.json({
    jobs,
    metrics: jobManager.getMetrics()
  });
});

app.get('/jobs/:id', (req, res) => {
  const job = jobManager.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({
      error: 'Job not found.'
    });
  }

  return res.json(job);
});

app.post('/jobs/:id/log-stream-token', (req, res) => {
  const job = jobManager.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({
      error: 'Job not found.'
    });
  }

  const token = generateId('stream');
  const expiresAt = Date.now() + 60_000;
  streamTokens.set(token, {
    jobId: req.params.id,
    expiresAt
  });

  for (const [storedToken, stored] of streamTokens.entries()) {
    if (stored.expiresAt <= Date.now()) {
      streamTokens.delete(storedToken);
    }
  }

  return res.json({
    streamToken: token,
    expiresAt: new Date(expiresAt).toISOString()
  });
});

function formatLogLine(line) {
  return `[${line.ts}] [${line.stream}] ${line.message}`;
}

app.get('/jobs/:id/logs', async (req, res) => {
  const job = jobManager.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({
      error: 'Job not found.'
    });
  }

  const follow = String(req.query.follow || '').toLowerCase();
  const offset = parsePositiveInt(req.query.offset, 0);
  const limit = parsePositiveInt(req.query.limit, 200);

  if (follow === '1' || follow === 'true' || follow === 'yes') {
    const snapshot = await jobManager.getLogs(req.params.id, offset, limit);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    for (const line of snapshot.lines) {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
    }

    const unsubscribe = jobManager.subscribeLogs(req.params.id, {
      onLine: (line) => {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
      },
      onDone: (finishedJob) => {
        res.write(`event: done\ndata: ${JSON.stringify(finishedJob)}\n\n`);
        res.end();
      }
    });

    req.on('close', () => {
      unsubscribe();
    });

    return undefined;
  }

  const data = await jobManager.getLogs(req.params.id, offset, limit);

  const format = String(req.query.format || 'json').toLowerCase();
  if (format === 'text') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    const lines = data.lines.map((line) => formatLogLine(line)).join('\n');
    return res.send(lines);
  }

  return res.json(data);
});

app.get('/jobs/:id/artifacts', (req, res) => {
  const job = jobManager.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({
      error: 'Job not found.'
    });
  }

  const artifacts = jobManager.getArtifacts(req.params.id) || [];
  return res.json({
    jobId: req.params.id,
    artifacts: artifacts.map((artifact) => ({
      ...artifact,
      downloadUrl: `/jobs/${req.params.id}/artifacts/${artifact.id}`
    }))
  });
});

app.get('/jobs/:id/artifacts/:artifactId', (req, res) => {
  const job = jobManager.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({
      error: 'Job not found.'
    });
  }

  if (job.cleanedUpAt) {
    return res.status(410).json({
      error: 'Artifacts were cleaned up due to retention policy.'
    });
  }

  const artifact = jobManager.getArtifact(req.params.id, req.params.artifactId);
  if (!artifact) {
    return res.status(404).json({
      error: 'Artifact not found.'
    });
  }

  if (artifact.kind === 'file') {
    return res.download(artifact.absolutePath, artifact.name);
  }

  const parentDir = path.dirname(artifact.absolutePath);
  const baseName = path.basename(artifact.absolutePath);
  const outputName = `${artifact.name}.tar.gz`;

  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${outputName}"`);

  const tarProcess = spawn('tar', ['-czf', '-', '-C', parentDir, baseName], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  tarProcess.stdout.pipe(res);
  tarProcess.stderr.on('data', () => {
    // Suppress tar noise in API response.
  });

  tarProcess.on('error', (error) => {
    if (!res.headersSent) {
      res.status(500).json({ error: `Failed to archive artifact: ${error.message}` });
    } else {
      res.end();
    }
  });

  tarProcess.on('close', (code) => {
    if (code !== 0 && !res.writableEnded) {
      res.end();
    }
  });

  return undefined;
});

app.post('/jobs/:id/cancel', (req, res) => {
  const result = jobManager.cancelJob(req.params.id);
  if (!result.ok) {
    if (result.message === 'Job not found.') {
      return res.status(404).json({ error: result.message });
    }
    return res.status(409).json({ error: result.message });
  }

  return res.json({
    message: result.message,
    job: jobManager.formatJob(result.job)
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found.'
  });
});

app.use((err, req, res, next) => {
  void next;
  logEvent('error', 'unhandled_error', {
    requestId: req.requestId,
    message: err.message
  });

  res.status(500).json({
    error: 'Internal server error',
    requestId: req.requestId
  });
});

async function start() {
  await jobManager.init();

  app.listen(config.port, () => {
    logEvent('info', 'service_started', {
      port: config.port,
      workRoot: config.workRoot,
      concurrencyLimit: config.concurrencyLimit,
      allowlist: config.allowedCommands
    });
  });
}

start().catch((error) => {
  logEvent('error', 'service_start_failed', { message: error.message });
  process.exit(1);
});
