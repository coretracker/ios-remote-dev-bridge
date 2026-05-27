const test = require('node:test');
const assert = require('node:assert/strict');

test('custom env allowlists extend defaults instead of replacing them', () => {
  const originalPrefixes = process.env.ALLOWED_ENV_PREFIXES;
  const originalKeys = process.env.ALLOWED_ENV_KEYS;

  process.env.ALLOWED_ENV_PREFIXES = 'CUSTOM_';
  process.env.ALLOWED_ENV_KEYS = 'EXTRA_KEY';

  delete require.cache[require.resolve('../src/config')];
  const { buildConfig } = require('../src/config');
  const config = buildConfig();

  try {
    assert.ok(config.allowPatterns.prefixes.includes('HARNESS_'));
    assert.ok(config.allowPatterns.prefixes.includes('CUSTOM_'));
    assert.ok(config.allowPatterns.exactKeys.has('HARNESS_FORMAT_MODE'));
    assert.ok(config.allowPatterns.exactKeys.has('EXTRA_KEY'));
  } finally {
    if (originalPrefixes === undefined) {
      delete process.env.ALLOWED_ENV_PREFIXES;
    } else {
      process.env.ALLOWED_ENV_PREFIXES = originalPrefixes;
    }

    if (originalKeys === undefined) {
      delete process.env.ALLOWED_ENV_KEYS;
    } else {
      process.env.ALLOWED_ENV_KEYS = originalKeys;
    }

    delete require.cache[require.resolve('../src/config')];
  }
});
