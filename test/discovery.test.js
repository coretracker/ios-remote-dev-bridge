const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { discoverRepository, resolveCommand } = require('../src/discovery');

async function withTempRepo(setup) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-discovery-'));
  try {
    await setup(root);
    return root;
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function writeFile(filePath, contents, mode) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
  if (mode !== undefined) {
    await fs.chmod(filePath, mode);
  }
}

test('discovers lowercase shell harness commands in a Swift repo', async (t) => {
  const repoRoot = await withTempRepo(async (root) => {
    await writeFile(path.join(root, 'Package.swift'), '// swift package\n');
    await writeFile(path.join(root, 'scripts', 'harness', 'setup.sh'), '#!/bin/sh\necho setup\n', 0o755);
    await writeFile(path.join(root, 'scripts', 'harness', 'check.sh'), '#!/bin/sh\necho check\n', 0o755);
    await writeFile(path.join(root, 'scripts', 'harness', 'test.sh'), '#!/bin/sh\necho test\n', 0o755);
    await writeFile(path.join(root, 'scripts', 'harness', 'start.sh'), '#!/bin/sh\necho start\n', 0o755);
    await writeFile(path.join(root, 'scripts', 'harness', 'pr-ready.sh'), '#!/bin/sh\necho pr\n', 0o755);
    await writeFile(path.join(root, 'scripts', 'harness', 'logs.sh'), '#!/bin/sh\necho logs\n', 0o755);
  });

  t.after(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  const discovery = await discoverRepository(repoRoot);

  assert.equal(discovery.repoType, 'swift');
  assert.equal(discovery.packageManager, 'unknown');
  assert.equal(discovery.commands.setup.type, 'script');
  assert.equal(discovery.commands.setup.sourceId, 'scripts/harness/setup.sh');
  assert.equal(discovery.commands.setup.exists, true);
  assert.equal(discovery.commands.setup.executable, true);
  assert.equal(discovery.commands.build.sourceId, 'scripts/harness/check.sh');
  assert.equal(discovery.commands.logs.sourceId, 'scripts/harness/logs.sh');
  assert.deepEqual(discovery.missingRecommended, []);
  assert.match(discovery.commands.setup.path, /scripts\/harness\/setup\.sh$/);
});

test('discovers uppercase harness commands in an Xcode repo', async (t) => {
  const repoRoot = await withTempRepo(async (root) => {
    await fs.mkdir(path.join(root, 'MyApp.xcodeproj'), { recursive: true });
    await writeFile(path.join(root, 'Scripts', 'harness', 'setup.sh'), '#!/bin/sh\necho setup\n', 0o755);
    await writeFile(path.join(root, 'Scripts', 'harness', 'check.sh'), '#!/bin/sh\necho check\n', 0o755);
    await writeFile(path.join(root, 'Scripts', 'harness', 'test.sh'), '#!/bin/sh\necho test\n', 0o755);
  });

  t.after(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  const discovery = await discoverRepository(repoRoot);

  assert.equal(discovery.repoType, 'xcode');
  assert.equal(discovery.commands.setup.sourceId, 'Scripts/harness/setup.sh');
  assert.equal(discovery.commands.checks.sourceId, 'Scripts/harness/check.sh');
  assert.equal(discovery.commands.tests.sourceId, 'Scripts/harness/test.sh');
  assert.ok(discovery.missing.launch);
});

test('rejects nonexistent repository paths', async () => {
  const missingPath = path.join(os.tmpdir(), 'bridge-missing-repo-does-not-exist');

  await assert.rejects(
    discoverRepository(missingPath),
    (error) => error && error.code === 'repo_path_missing'
  );
});

test('discovers simple fallback scripts in a tiny repo with no package metadata', async (t) => {
  const repoRoot = await withTempRepo(async (root) => {
    await writeFile(path.join(root, 'scripts', 'setup.sh'), '#!/bin/sh\necho setup\n', 0o755);
    await writeFile(path.join(root, 'scripts', 'test.sh'), '#!/bin/sh\necho test\n', 0o755);
  });

  t.after(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  const discovery = await discoverRepository(repoRoot);

  assert.equal(discovery.repoType, 'unknown');
  assert.equal(discovery.commands.setup.sourceId, 'scripts/setup.sh');
  assert.equal(discovery.commands.tests.sourceId, 'scripts/test.sh');
  assert.ok(discovery.missing.checks.checkedPaths.includes('scripts/harness/check.sh'));
});

test('reports non-executable discovered scripts clearly', async (t) => {
  const repoRoot = await withTempRepo(async (root) => {
    await writeFile(path.join(root, 'scripts', 'setup.sh'), '#!/bin/sh\necho setup\n', 0o644);
  });

  t.after(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  const discovery = await discoverRepository(repoRoot);
  const resolved = resolveCommand(discovery, 'setup', []);

  assert.equal(discovery.commands.setup.executable, false);
  assert.equal(resolved.ok, false);
  assert.match(resolved.message, /chmod \+x scripts\/setup\.sh/);
});
