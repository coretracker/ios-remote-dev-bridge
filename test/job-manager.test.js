const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { JobManager } = require('../src/job-manager');

function createConfig() {
  return {
    workRoot: '/tmp/bridge-test-work',
    redactionKeywords: ['TOKEN', 'SECRET', 'PASSWORD', 'KEY', 'AUTH', 'CREDENTIAL'],
    allowedExecutables: [],
    allowedCommands: [],
    commandOverrides: {},
    concurrencyLimit: 1,
    defaultTimeoutMs: 1000,
    maxTimeoutMs: 1000,
    jobRetentionMs: 60000,
    simulatorDevice: '',
    simulatorOS: '',
    logLineLimit: 1000
  };
}

test('normalizeEnv accepts all provided environment variables', () => {
  const manager = new JobManager(createConfig(), () => {});

  const accepted = manager.normalizeEnv({
    HARNESS_FORMAT_MODE: 'apply',
    HARNESS_OTHER_FLAG: '1',
    NOT_ALLOWED: 'x',
    NULLISH_VALUE: null
  });

  assert.deepEqual(accepted, {
    HARNESS_FORMAT_MODE: 'apply',
    HARNESS_OTHER_FLAG: '1',
    NOT_ALLOWED: 'x',
    NULLISH_VALUE: ''
  });
});

test('jobs run in the original repo folder when no repoRef is requested', async (t) => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-work-root-'));
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-source-repo-'));

  t.after(async () => {
    await fs.rm(workRoot, { recursive: true, force: true });
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  const manager = new JobManager({
    ...createConfig(),
    workRoot
  }, () => {});

  const job = {
    repoPath: repoRoot,
    repoRef: '',
    repoWorkspace: repoRoot,
    workspaceClonePath: path.join(workRoot, 'job_test', 'repo')
  };

  await manager.prepareWorkspace(job);

  assert.equal(job.repoWorkspace, repoRoot);
  assert.notEqual(job.repoWorkspace, job.workspaceClonePath);
});
