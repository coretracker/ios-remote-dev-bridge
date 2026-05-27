const { spawn } = require('child_process');

function runCommand(command, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, error: 'timeout', stdout, stderr, exitCode: null });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, error: error.message, stdout, stderr, exitCode: null });
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ ok: code === 0, stdout, stderr, exitCode: code });
    });
  });
}

function firstLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

async function probeExecutable(name, versionArgs) {
  const versionResult = await runCommand(name, versionArgs);
  if (!versionResult.ok) {
    return {
      name,
      available: false,
      version: '',
      details: firstLine(versionResult.stderr) || firstLine(versionResult.stdout) || versionResult.error || ''
    };
  }

  return {
    name,
    available: true,
    version: firstLine(versionResult.stdout) || firstLine(versionResult.stderr),
    details: ''
  };
}

async function probeSimctl() {
  const simctlResult = await runCommand('xcrun', ['simctl', 'list', 'devices']);
  if (!simctlResult.ok) {
    return {
      name: 'simctl',
      available: false,
      version: '',
      details: firstLine(simctlResult.stderr) || firstLine(simctlResult.stdout) || simctlResult.error || ''
    };
  }

  const xcrunVersion = await runCommand('xcrun', ['--version']);

  return {
    name: 'simctl',
    available: true,
    version: firstLine(xcrunVersion.stdout) || firstLine(simctlResult.stdout),
    details: ''
  };
}

async function getCapabilities() {
  const tools = await Promise.all([
    probeExecutable('node', ['--version']),
    probeExecutable('git', ['--version']),
    probeExecutable('make', ['--version']),
    probeExecutable('npm', ['--version']),
    probeExecutable('pnpm', ['--version']),
    probeExecutable('yarn', ['--version']),
    probeExecutable('swift', ['--version']),
    probeExecutable('xcodebuild', ['-version']),
    probeSimctl()
  ]);

  return {
    generatedAt: new Date().toISOString(),
    tools
  };
}

module.exports = {
  getCapabilities
};
