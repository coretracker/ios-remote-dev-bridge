const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const { discoverRepository, resolveCommand } = require('./discovery');
const {
  collectSecrets,
  ensureDir,
  fileExists,
  flushLineBuffers,
  generateId,
  isSubPath,
  nowIso,
  redactText,
  sha256,
  splitLines
} = require('./utils');

class JobManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.jobs = new Map();
    this.queue = [];
    this.runningCount = 0;
    this.idempotencyKeys = new Map();
    this.jobEvents = new Map();
    this.cleanupTimers = new Map();
    this.metrics = {
      total: 0,
      passed: 0,
      failed: 0,
      canceled: 0,
      timedOut: 0,
      totalDurationMs: 0,
      totalQueueWaitMs: 0
    };
  }

  async init() {
    await ensureDir(this.config.workRoot);
  }

  getOrCreateEmitter(jobId) {
    if (!this.jobEvents.has(jobId)) {
      this.jobEvents.set(jobId, new EventEmitter());
    }
    return this.jobEvents.get(jobId);
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }
    return this.formatJob(job);
  }

  listJobs() {
    return Array.from(this.jobs.values()).map((job) => this.formatJob(job));
  }

  formatJob(job) {
    const queueWaitMs = job.startedAt
      ? Math.max(0, new Date(job.startedAt).getTime() - new Date(job.queuedAt).getTime())
      : null;

    const durationMs = job.startedAt
      ? Math.max(0, new Date(job.finishedAt || nowIso()).getTime() - new Date(job.startedAt).getTime())
      : null;

    return {
      id: job.id,
      requestId: job.requestId,
      status: job.status,
      commandKey: job.commandKey,
      commandDisplay: job.commandDisplay,
      repoPath: job.repoPath,
      repoRoot: job.repoRoot,
      repoRef: job.repoRef,
      queuePosition: job.status === 'queued' ? this.queue.indexOf(job.id) + 1 : null,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      queueWaitMs,
      durationMs,
      exitCode: job.exitCode,
      timeoutMs: job.timeoutMs,
      timedOut: job.timedOut,
      canceled: job.cancelRequested,
      error: job.error,
      cleanedUpAt: job.cleanedUpAt,
      artifactCount: job.artifacts.length,
      envRejected: job.envRejected
    };
  }

  getMetrics() {
    const completed = this.metrics.passed + this.metrics.failed + this.metrics.canceled;
    return {
      ...this.metrics,
      running: this.runningCount,
      queued: this.queue.length,
      avgDurationMs: completed ? Math.round(this.metrics.totalDurationMs / completed) : 0,
      avgQueueWaitMs: completed ? Math.round(this.metrics.totalQueueWaitMs / completed) : 0
    };
  }

  createIdempotencyFingerprint(payload) {
    return sha256(JSON.stringify(payload));
  }

  createJob(input) {
    const repoPath = path.resolve(input.repoPath);
    const payloadForFingerprint = {
      commandKey: input.commandKey,
      args: input.args || [],
      env: input.env || {},
      repoPath,
      repoRef: input.repoRef || '',
      timeoutMs: input.timeoutMs
    };

    if (input.idempotencyKey) {
      const existing = this.idempotencyKeys.get(input.idempotencyKey);
      const fingerprint = this.createIdempotencyFingerprint(payloadForFingerprint);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          const error = new Error('Idempotency key reuse with different payload is not allowed.');
          error.code = 'idempotency_conflict';
          throw error;
        }

        const existingJob = this.jobs.get(existing.jobId);
        if (existingJob) {
          return { job: existingJob, reused: true };
        }
      }

      this.idempotencyKeys.set(input.idempotencyKey, {
        fingerprint,
        jobId: ''
      });
    }

    const jobId = generateId('job');
    const createdAt = nowIso();
    const jobRoot = path.join(this.config.workRoot, jobId);

    const job = {
      id: jobId,
      requestId: input.requestId,
      status: 'queued',
      commandKey: input.commandKey,
      commandDisplay: '',
      repoPath,
      repoRoot: '',
      repoRef: input.repoRef || '',
      timeoutMs: input.timeoutMs,
      requestedEnv: input.env || {},
      args: Array.isArray(input.args) ? input.args.map((entry) => String(entry)) : [],
      deterministic: input.deterministic || {},
      queuedAt: createdAt,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      timedOut: false,
      cancelRequested: false,
      error: '',
      envRejected: [],
      jobRoot,
      repoWorkspace: path.join(jobRoot, 'repo'),
      artifactsRoot: path.join(jobRoot, 'artifacts'),
      logFile: path.join(jobRoot, 'job.log.jsonl'),
      derivedDataDir: path.join(jobRoot, 'derived-data'),
      processHandle: null,
      processPid: null,
      timeoutHandle: null,
      artifacts: [],
      cleanedUpAt: null
    };

    this.jobs.set(jobId, job);
    this.queue.push(jobId);
    this.metrics.total += 1;

    if (input.idempotencyKey) {
      const current = this.idempotencyKeys.get(input.idempotencyKey);
      this.idempotencyKeys.set(input.idempotencyKey, {
        ...current,
        jobId
      });
    }

    this.logger('info', 'job_queued', {
      jobId,
      requestId: input.requestId,
      commandKey: job.commandKey,
      repoPath,
      timeoutMs: job.timeoutMs
    });

    this.dispatch();

    return { job, reused: false };
  }

  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { ok: false, message: 'Job not found.' };
    }

    if (['passed', 'failed', 'canceled'].includes(job.status)) {
      return { ok: false, message: `Job is already ${job.status}.` };
    }

    if (job.status === 'queued') {
      this.queue = this.queue.filter((queuedId) => queuedId !== jobId);
      job.status = 'canceled';
      job.cancelRequested = true;
      job.finishedAt = nowIso();
      this.metrics.canceled += 1;
      this.getOrCreateEmitter(jobId).emit('done', this.formatJob(job));
      this.scheduleCleanup(job);
      return { ok: true, message: 'Queued job canceled.', job };
    }

    job.cancelRequested = true;
    this.terminateProcess(job, 'SIGTERM');
    setTimeout(() => {
      if (job.status === 'running') {
        this.terminateProcess(job, 'SIGKILL');
      }
    }, 2500);

    return { ok: true, message: 'Cancellation requested.', job };
  }

  terminateProcess(job, signal) {
    if (!job.processHandle || !job.processPid) {
      return;
    }

    try {
      process.kill(-job.processPid, signal);
    } catch {
      try {
        job.processHandle.kill(signal);
      } catch {
        // Ignore process-kill failures.
      }
    }
  }

  dispatch() {
    while (this.runningCount < this.config.concurrencyLimit && this.queue.length > 0) {
      const nextId = this.queue.shift();
      const job = this.jobs.get(nextId);
      if (!job || job.status !== 'queued') {
        continue;
      }

      this.runningCount += 1;
      void this.runJob(job)
        .catch((error) => {
          this.logger('error', 'job_runner_error', {
            jobId: job.id,
            message: error.message
          });
        })
        .finally(() => {
          this.runningCount -= 1;
          this.dispatch();
        });
    }
  }

  async runJob(job) {
    job.status = 'running';
    job.startedAt = nowIso();
    this.metrics.totalQueueWaitMs += Math.max(
      0,
      new Date(job.startedAt).getTime() - new Date(job.queuedAt).getTime()
    );

    this.logger('info', 'job_started', {
      jobId: job.id,
      requestId: job.requestId,
      commandKey: job.commandKey
    });

    await ensureDir(job.jobRoot);
    await ensureDir(job.artifactsRoot);
    await ensureDir(job.derivedDataDir);

    const redactionSecrets = collectSecrets(process.env, this.config.redactionKeywords);

    try {
      await this.prepareWorkspace(job);

      const discovery = await discoverRepository(job.repoWorkspace);
      job.repoRoot = discovery.repoRoot;

      const resolved = this.resolveCommand(job, discovery);
      if (!resolved.ok) {
        const error = new Error(resolved.message);
        error.code = 'command_not_found';
        throw error;
      }

      job.commandDisplay = resolved.display;

      const { accepted, rejected } = this.filterEnv(job.requestedEnv);
      job.envRejected = rejected;
      const runEnv = this.buildExecutionEnv(job, accepted);
      const secrets = redactionSecrets.concat(collectSecrets(accepted, this.config.redactionKeywords));

      if (rejected.length) {
        await this.appendLog(job, 'system', `Rejected env keys: ${rejected.join(', ')}`, secrets);
      }

      await this.appendLog(job, 'system', `Starting command: ${resolved.display}`, secrets);
      if (job.repoRef) {
        await this.appendLog(job, 'system', `Checked out ref: ${job.repoRef}`, secrets);
      }

      const executionResult = await this.executeCommand(job, resolved.command, resolved.args, runEnv, secrets);
      job.exitCode = executionResult.exitCode;

      if (job.cancelRequested) {
        job.status = 'canceled';
      } else if (job.timedOut) {
        job.status = 'failed';
        job.error = `Job timed out after ${job.timeoutMs}ms.`;
      } else if (executionResult.exitCode === 0) {
        job.status = 'passed';
      } else {
        job.status = 'failed';
        job.error = `Command exited with code ${executionResult.exitCode}.`;
      }

      if (executionResult.spawnError) {
        job.status = 'failed';
        job.error = executionResult.spawnError;
      }
    } catch (error) {
      if (job.cancelRequested) {
        job.status = 'canceled';
      } else {
        job.status = 'failed';
      }
      job.error = error.message;
      await this.appendLog(job, 'system', `Execution error: ${error.message}`, redactionSecrets);
    } finally {
      if (job.timeoutHandle) {
        clearTimeout(job.timeoutHandle);
      }

      job.finishedAt = nowIso();
      this.metrics.totalDurationMs += Math.max(
        0,
        new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()
      );

      if (job.status === 'passed') {
        this.metrics.passed += 1;
      } else if (job.status === 'canceled') {
        this.metrics.canceled += 1;
      } else {
        this.metrics.failed += 1;
        if (job.timedOut) {
          this.metrics.timedOut += 1;
        }
      }

      await this.collectArtifacts(job);

      this.logger('info', 'job_finished', {
        jobId: job.id,
        requestId: job.requestId,
        status: job.status,
        exitCode: job.exitCode,
        timedOut: job.timedOut,
        error: job.error
      });

      const emitter = this.getOrCreateEmitter(job.id);
      emitter.emit('done', this.formatJob(job));

      this.scheduleCleanup(job);
    }
  }

  async prepareWorkspace(job) {
    const sourcePath = job.repoPath;
    let sourceStat;

    try {
      sourceStat = await fsPromises.stat(sourcePath);
    } catch {
      const error = new Error(`Repository path does not exist: ${sourcePath}`);
      error.code = 'repo_path_missing';
      throw error;
    }

    if (!sourceStat.isDirectory()) {
      const error = new Error(`Repository path is not a directory: ${sourcePath}`);
      error.code = 'repo_path_not_directory';
      throw error;
    }

    await ensureDir(path.dirname(job.repoWorkspace));

    const sourceGitPath = path.join(sourcePath, '.git');
    const isGitRepo = await fileExists(sourceGitPath);

    if (job.repoRef) {
      if (!isGitRepo) {
        const error = new Error(`Repository ref '${job.repoRef}' requested, but repo is not a git checkout.`);
        error.code = 'repo_ref_not_supported';
        throw error;
      }

      const cloneResult = await this.runPrepCommand('git', ['clone', '--quiet', '--no-hardlinks', sourcePath, job.repoWorkspace]);
      if (!cloneResult.ok) {
        const error = new Error(`Failed to clone repository: ${cloneResult.error}`);
        error.code = 'repo_clone_failed';
        throw error;
      }

      const checkoutResult = await this.runPrepCommand('git', ['-C', job.repoWorkspace, 'checkout', '--quiet', job.repoRef]);
      if (!checkoutResult.ok) {
        const error = new Error(`Unable to checkout ref '${job.repoRef}': ${checkoutResult.error}`);
        error.code = 'repo_ref_invalid';
        throw error;
      }
      return;
    }

    await this.copyDirectoryTree(sourcePath, job.repoWorkspace);
  }

  shouldSkipCopyPath(absolutePath) {
    const workRoot = path.resolve(this.config.workRoot);
    const resolved = path.resolve(absolutePath);
    return resolved === workRoot || resolved.startsWith(`${workRoot}${path.sep}`);
  }

  async copyDirectoryTree(sourcePath, destPath) {
    const sourceAbsolute = path.resolve(sourcePath);
    if (this.shouldSkipCopyPath(sourceAbsolute)) {
      return;
    }

    const stat = await fsPromises.lstat(sourceAbsolute);
    if (stat.isSymbolicLink()) {
      const target = await fsPromises.readlink(sourceAbsolute);
      await fsPromises.symlink(target, destPath);
      return;
    }

    if (stat.isDirectory()) {
      await ensureDir(destPath);
      const entries = await fsPromises.readdir(sourceAbsolute);
      for (const entry of entries) {
        const childSource = path.join(sourceAbsolute, entry);
        const childDest = path.join(destPath, entry);

        if (this.shouldSkipCopyPath(childSource)) {
          continue;
        }

        await this.copyDirectoryTree(childSource, childDest);
      }
      return;
    }

    await ensureDir(path.dirname(destPath));
    await fsPromises.copyFile(sourceAbsolute, destPath);
    await fsPromises.chmod(destPath, stat.mode);
  }

  runPrepCommand(command, args) {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (error) => {
        resolve({ ok: false, error: error.message });
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ ok: true });
          return;
        }
        resolve({ ok: false, error: stderr.trim() || stdout.trim() || `Exit code ${code}` });
      });
    });
  }

  isExecutableAllowed(command) {
    const executable = path.basename(String(command || '').trim());
    return this.config.allowedExecutables.includes(executable);
  }

  executablePolicyError(command) {
    const executable = path.basename(String(command || '').trim()) || String(command || '').trim();
    return `Executable '${executable}' is not allowed. Allowed executables: ${this.config.allowedExecutables.join(', ')}`;
  }

  enforceExecutablePolicy(resolved, discovery) {
    if (!resolved || !resolved.ok) {
      return resolved;
    }

    if (resolved.type === 'script') {
      if (!resolved.discovered || !resolved.path || !isSubPath(discovery.repoRoot, resolved.path)) {
        return {
          ok: false,
          message: 'Discovered script is outside the repository root, which is not allowed.'
        };
      }

      return resolved;
    }

    if (!this.isExecutableAllowed(resolved.command)) {
      return {
        ok: false,
        message: this.executablePolicyError(resolved.command)
      };
    }

    return resolved;
  }

  resolveCommand(job, discovery) {
    const override = this.config.commandOverrides[job.commandKey];
    if (override) {
      const parsed = this.parseOverride(override, job.args);
      if (!parsed.ok) {
        return parsed;
      }

      return this.enforceExecutablePolicy({
        ok: true,
        command: parsed.command,
        args: parsed.args,
        display: parsed.display
      }, discovery);
    }

    return this.enforceExecutablePolicy(resolveCommand(discovery, job.commandKey, job.args), discovery);
  }

  parseOverride(override, extraArgs) {
    if (Array.isArray(override) && override.length >= 1) {
      const [command, ...baseArgs] = override.map((value) => String(value));
      const finalArgs = baseArgs.concat((extraArgs || []).map((value) => String(value)));
      return {
        ok: true,
        command,
        args: finalArgs,
        display: [command].concat(finalArgs).join(' ')
      };
    }

    if (override && typeof override === 'object' && typeof override.command === 'string') {
      const baseArgs = Array.isArray(override.args) ? override.args.map((value) => String(value)) : [];
      const finalArgs = baseArgs.concat((extraArgs || []).map((value) => String(value)));
      return {
        ok: true,
        command: override.command,
        args: finalArgs,
        display: [override.command].concat(finalArgs).join(' ')
      };
    }

    return {
      ok: false,
      message: 'Invalid command override format. Use array form ["cmd","arg"] or {"command":"cmd","args":[...]}.'
    };
  }

  filterEnv(envInput) {
    const incoming = envInput && typeof envInput === 'object' ? envInput : {};
    const accepted = {};
    const rejected = [];

    for (const [rawKey, rawValue] of Object.entries(incoming)) {
      const key = String(rawKey);
      const value = rawValue === undefined || rawValue === null ? '' : String(rawValue);
      const isAllowedExact = this.config.allowPatterns.exactKeys.has(key);
      const isAllowedPrefix = this.config.allowPatterns.prefixes.some((prefix) => key.startsWith(prefix));

      if (!isAllowedExact && !isAllowedPrefix) {
        rejected.push(key);
        continue;
      }

      accepted[key] = value;
    }

    return { accepted, rejected };
  }

  buildExecutionEnv(job, acceptedEnv) {
    const base = {};
    const passthroughKeys = ['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'DEVELOPER_DIR', 'SDKROOT'];

    for (const key of passthroughKeys) {
      if (process.env[key]) {
        base[key] = process.env[key];
      }
    }

    const deterministic = {
      BRIDGE_JOB_ID: job.id,
      BRIDGE_WORK_ROOT: job.jobRoot,
      BRIDGE_REPO_DIR: job.repoWorkspace,
      BRIDGE_DERIVED_DATA_DIR: job.derivedDataDir,
      DERIVED_DATA_PATH: job.derivedDataDir,
      XCODE_DERIVED_DATA_PATH: job.derivedDataDir,
      NSUnbufferedIO: 'YES'
    };

    const simulatorName = job.deterministic.simulatorName || this.config.simulatorDevice;
    const simulatorOS = job.deterministic.simulatorOS || this.config.simulatorOS;

    if (simulatorName) {
      deterministic.BRIDGE_SIMULATOR_NAME = simulatorName;
      deterministic.SIMULATOR_DEVICE_NAME = simulatorName;
    }
    if (simulatorOS) {
      deterministic.BRIDGE_SIMULATOR_OS = simulatorOS;
      deterministic.SIMULATOR_RUNTIME = simulatorOS;
    }

    return {
      ...base,
      ...deterministic,
      ...acceptedEnv
    };
  }

  executeCommand(job, command, args, env, secrets) {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: job.repoWorkspace,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      });

      const buffers = {
        stdout: '',
        stderr: ''
      };

      let settled = false;

      const settle = (payload) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(payload);
      };

      job.processHandle = child;
      job.processPid = child.pid;

      job.timeoutHandle = setTimeout(() => {
        job.timedOut = true;
        this.appendLog(job, 'system', `Timeout reached (${job.timeoutMs}ms).`, secrets).catch(() => {});
        this.terminateProcess(job, 'SIGTERM');
        setTimeout(() => {
          this.terminateProcess(job, 'SIGKILL');
        }, 2500);
      }, job.timeoutMs);

      const processLine = (streamName, line) => {
        if (!line) {
          return;
        }
        this.appendLog(job, streamName, line, secrets).catch(() => {});
      };

      child.stdout.on('data', (chunk) => {
        splitLines('stdout', chunk, buffers, (line) => processLine('stdout', line));
      });

      child.stderr.on('data', (chunk) => {
        splitLines('stderr', chunk, buffers, (line) => processLine('stderr', line));
      });

      child.on('error', (error) => {
        flushLineBuffers(buffers, (line) => processLine('system', line));
        settle({ exitCode: null, spawnError: error.message });
      });

      child.on('close', (code) => {
        flushLineBuffers(buffers, (line) => processLine('system', line));
        settle({ exitCode: code, spawnError: '' });
      });
    });
  }

  async appendLog(job, stream, message, secrets) {
    const sanitized = redactText(message, secrets || []);
    const entry = {
      ts: nowIso(),
      stream,
      message: sanitized
    };

    await fsPromises.appendFile(job.logFile, `${JSON.stringify(entry)}\n`, 'utf8');
    this.getOrCreateEmitter(job.id).emit('line', entry);
  }

  scheduleCleanup(job) {
    if (this.cleanupTimers.has(job.id)) {
      clearTimeout(this.cleanupTimers.get(job.id));
    }

    const timer = setTimeout(async () => {
      await fsPromises.rm(job.jobRoot, { recursive: true, force: true });
      job.cleanedUpAt = nowIso();
      this.logger('info', 'job_workspace_cleaned', { jobId: job.id });
    }, this.config.jobRetentionMs);

    this.cleanupTimers.set(job.id, timer);
  }

  async readLogEntries(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }

    let fileText = '';
    try {
      fileText = await fsPromises.readFile(job.logFile, 'utf8');
    } catch {
      fileText = '';
    }

    const entries = fileText
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { ts: nowIso(), stream: 'system', message: line };
        }
      });

    return entries;
  }

  async getLogs(jobId, offset, limit) {
    const entries = await this.readLogEntries(jobId);
    if (!entries) {
      return null;
    }

    const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 2000) : 200;
    const lines = entries.slice(safeOffset, safeOffset + safeLimit);

    return {
      total: entries.length,
      offset: safeOffset,
      limit: safeLimit,
      lines
    };
  }

  subscribeLogs(jobId, handlers) {
    const emitter = this.getOrCreateEmitter(jobId);

    const lineHandler = (entry) => {
      handlers.onLine(entry);
    };

    const doneHandler = (job) => {
      if (handlers.onDone) {
        handlers.onDone(job);
      }
    };

    emitter.on('line', lineHandler);
    emitter.on('done', doneHandler);

    return () => {
      emitter.off('line', lineHandler);
      emitter.off('done', doneHandler);
    };
  }

  async collectArtifacts(job) {
    const candidates = new Set();
    const output = [];

    if (await fileExists(job.logFile)) {
      output.push(await this.toArtifact(job, job.logFile, 'job-log'));
    }

    const roots = [
      path.join(job.repoWorkspace, 'artifacts'),
      path.join(job.repoWorkspace, 'reports'),
      path.join(job.repoWorkspace, 'test-results'),
      path.join(job.repoWorkspace, 'build'),
      path.join(job.repoWorkspace, 'DerivedData'),
      path.join(job.repoWorkspace, 'derived-data'),
      path.join(job.repoWorkspace, '.build'),
      job.derivedDataDir,
      job.artifactsRoot
    ];

    for (const root of roots) {
      if (await fileExists(root)) {
        await this.walkArtifacts(job, root, candidates, output, 0, 5);
      }
    }

    job.artifacts = output;
  }

  isInterestingArtifact(filePath) {
    const lower = filePath.toLowerCase();
    const artifactExtensions = [
      '.log', '.txt', '.xml', '.json', '.html', '.xcresult', '.xcarchive', '.xcactivitylog', '.trace', '.png', '.jpg', '.jpeg', '.mp4', '.zip'
    ];

    if (artifactExtensions.some((ext) => lower.endsWith(ext))) {
      return true;
    }

    return [
      'junit',
      'coverage',
      'result',
      'report',
      'screenshot',
      'simulator'
    ].some((needle) => lower.includes(needle));
  }

  async walkArtifacts(job, currentPath, seen, output, depth, maxDepth) {
    if (depth > maxDepth) {
      return;
    }

    const normalized = path.resolve(currentPath);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);

    let stat;
    try {
      stat = await fsPromises.stat(normalized);
    } catch {
      return;
    }

    if (stat.isFile()) {
      if (!this.isInterestingArtifact(normalized)) {
        return;
      }
      output.push(await this.toArtifact(job, normalized));
      return;
    }

    const lower = normalized.toLowerCase();
    if (stat.isDirectory() && (lower.endsWith('.xcresult') || lower.endsWith('.xcarchive') || lower.endsWith('.logarchive'))) {
      output.push(await this.toArtifact(job, normalized));
      return;
    }

    if (!stat.isDirectory()) {
      return;
    }

    let entries = [];
    try {
      entries = await fsPromises.readdir(normalized);
    } catch {
      return;
    }

    for (const entry of entries.slice(0, 500)) {
      await this.walkArtifacts(job, path.join(normalized, entry), seen, output, depth + 1, maxDepth);
      if (output.length >= 200) {
        return;
      }
    }
  }

  async toArtifact(job, absolutePath, forcedId) {
    const stat = await fsPromises.stat(absolutePath);
    const artifactId = forcedId || generateId('artifact');
    const relativePath = path.relative(job.jobRoot, absolutePath);

    return {
      id: artifactId,
      name: path.basename(absolutePath),
      relativePath,
      absolutePath,
      sizeBytes: stat.size,
      kind: stat.isDirectory() ? 'directory' : 'file'
    };
  }

  getArtifacts(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }

    return job.artifacts.map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      relativePath: artifact.relativePath,
      sizeBytes: artifact.sizeBytes,
      kind: artifact.kind
    }));
  }

  getArtifact(jobId, artifactId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }

    const artifact = job.artifacts.find((item) => item.id === artifactId);
    if (!artifact) {
      return null;
    }

    return artifact;
  }

  async preflightCommand(commandKey, repoPath) {
    const discovery = await this.discover(repoPath);
    const resolved = this.resolveCommand({ commandKey, args: [] }, discovery);

    if (!resolved.ok) {
      return {
        ok: false,
        message: resolved.message,
        missing: discovery.missing[commandKey] || null
      };
    }

    return {
      ok: true,
      source: resolved.source,
      display: resolved.display,
      type: resolved.type,
      path: resolved.path,
      executable: resolved.executable
    };
  }

  async discover(repoPath) {
    return discoverRepository(path.resolve(repoPath));
  }
}

module.exports = {
  JobManager
};
