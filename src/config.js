const path = require('path');
require('dotenv').config();

const CANONICAL_COMMAND_KEYS = ['setup', 'checks', 'build', 'tests', 'launch', 'pr', 'logs', 'doctor'];
const ALLOWED_EXECUTABLES = ['swift', 'xcodebuild', 'xcrun', 'bundle', 'swiftformat', 'make', 'npm', 'pnpm', 'yarn', 'bun'];

function asInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  if (min !== undefined && parsed < min) {
    return min;
  }

  if (max !== undefined && parsed > max) {
    return max;
  }

  return parsed;
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function asList(value, fallback) {
  if (!value) {
    return fallback;
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function asJson(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function compileAllowPatterns(prefixes, exactKeys) {
  return {
    prefixes,
    exactKeys: new Set(exactKeys)
  };
}

function resolveWorkRoot() {
  const configured = process.env.WORK_ROOT || '.bridge-work';
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(process.cwd(), configured);
}

function buildConfig() {
  const allowedEnvPrefixes = asList(
    process.env.ALLOWED_ENV_PREFIXES,
    ['CI_', 'APP_', 'XCODE_', 'SIM_', 'FASTLANE_', 'BUILD_', 'TEST_']
  );

  const allowedEnvKeys = asList(
    process.env.ALLOWED_ENV_KEYS,
    ['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'DEVELOPER_DIR', 'SDKROOT', 'TMPDIR', 'HARNESS_FORMAT_MODE']
  );

  const allowlistExtra = asList(process.env.ALLOWED_COMMAND_KEYS, []);

  const configuredOverrides = asJson(process.env.COMMAND_OVERRIDES_JSON, {});

  return {
    port: asInt(process.env.PORT, 3000, 1, 65535),
    authToken: process.env.API_TOKEN || '',
    disableAuth: asBool(process.env.DISABLE_AUTH, false),
    requestBodyLimit: process.env.REQUEST_BODY_LIMIT || '1mb',
    concurrencyLimit: asInt(process.env.CONCURRENCY_LIMIT, 2, 1, 32),
    defaultTimeoutMs: asInt(process.env.DEFAULT_TIMEOUT_MS, 30 * 60 * 1000, 1_000, 24 * 60 * 60 * 1000),
    maxTimeoutMs: asInt(process.env.MAX_TIMEOUT_MS, 2 * 60 * 60 * 1000, 1_000, 24 * 60 * 60 * 1000),
    jobRetentionMs: asInt(process.env.JOB_RETENTION_MS, 24 * 60 * 60 * 1000, 60_000, 7 * 24 * 60 * 60 * 1000),
    workRoot: resolveWorkRoot(),
    allowedCommands: Array.from(new Set(CANONICAL_COMMAND_KEYS.concat(allowlistExtra))),
    allowedExecutables: ALLOWED_EXECUTABLES.slice(),
    commandOverrides: configuredOverrides,
    allowPatterns: compileAllowPatterns(allowedEnvPrefixes, allowedEnvKeys),
    redactionKeywords: asList(process.env.REDACT_ENV_KEYWORDS, ['TOKEN', 'SECRET', 'PASSWORD', 'KEY', 'AUTH', 'CREDENTIAL']),
    rateLimitWindowMs: asInt(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000, 1_000, 60 * 60 * 1000),
    rateLimitMaxRequests: asInt(process.env.RATE_LIMIT_MAX_REQUESTS, 120, 1, 10_000),
    simulatorDevice: process.env.DEFAULT_SIMULATOR_DEVICE || '',
    simulatorOS: process.env.DEFAULT_SIMULATOR_OS || '',
    logLineLimit: asInt(process.env.LOG_LINE_LIMIT, 20_000, 100, 1_000_000)
  };
}

module.exports = {
  ALLOWED_EXECUTABLES,
  CANONICAL_COMMAND_KEYS,
  config: buildConfig()
};
