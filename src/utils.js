const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function generateId(prefix = '') {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

function isSubPath(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function collectSecrets(envObject, keywords) {
  const secrets = new Set();
  const keyWordsUpper = keywords.map((item) => item.toUpperCase());

  for (const [key, value] of Object.entries(envObject || {})) {
    if (value === undefined || value === null) {
      continue;
    }

    const upperKey = key.toUpperCase();
    const looksSensitive = keyWordsUpper.some((kw) => upperKey.includes(kw));
    if (!looksSensitive) {
      continue;
    }

    const normalized = String(value).trim();
    if (normalized.length >= 4) {
      secrets.add(normalized);
    }
  }

  return Array.from(secrets);
}

function redactText(text, secretValues) {
  let output = String(text);
  for (const secret of secretValues) {
    if (!secret) {
      continue;
    }
    output = output.split(secret).join('***REDACTED***');
  }
  return output;
}

function splitLines(streamName, rawBuffer, state, onLine) {
  const previous = state[streamName] || '';
  const full = previous + rawBuffer.toString('utf8');
  const lines = full.split(/\r?\n/);
  state[streamName] = lines.pop() || '';

  for (const line of lines) {
    onLine(line);
  }
}

function flushLineBuffers(state, onLine) {
  for (const streamName of Object.keys(state)) {
    if (state[streamName]) {
      onLine(state[streamName]);
      state[streamName] = '';
    }
  }
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

module.exports = {
  collectSecrets,
  ensureDir,
  fileExists,
  flushLineBuffers,
  generateId,
  isSubPath,
  nowIso,
  parsePositiveInt,
  redactText,
  sha256,
  splitLines
};
