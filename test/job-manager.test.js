const test = require('node:test');
const assert = require('node:assert/strict');

const { JobManager } = require('../src/job-manager');

function createConfig() {
  return {
    workRoot: '/tmp/bridge-test-work',
    redactionKeywords: ['TOKEN', 'SECRET', 'PASSWORD', 'KEY', 'AUTH', 'CREDENTIAL'],
    allowPatterns: {
      prefixes: ['CI_', 'APP_', 'XCODE_', 'SIM_', 'FASTLANE_', 'BUILD_', 'TEST_', 'HARNESS_'],
      exactKeys: new Set(['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'DEVELOPER_DIR', 'SDKROOT', 'TMPDIR', 'HARNESS_FORMAT_MODE'])
    },
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

test('filterEnv accepts HARNESS_FORMAT_MODE and HARNESS_ prefixed variables', () => {
  const manager = new JobManager(createConfig(), () => {});

  const { accepted, rejected } = manager.filterEnv({
    HARNESS_FORMAT_MODE: 'apply',
    HARNESS_OTHER_FLAG: '1',
    NOT_ALLOWED: 'x'
  });

  assert.deepEqual(accepted, {
    HARNESS_FORMAT_MODE: 'apply',
    HARNESS_OTHER_FLAG: '1'
  });
  assert.deepEqual(rejected, ['NOT_ALLOWED']);
});
