const fs = require('fs/promises');
const path = require('path');
const { fileExists } = require('./utils');

const CANDIDATES = {
  setup: ['setup', 'bootstrap', 'install', 'init', 'prepare'],
  checks: ['check', 'checks', 'lint', 'verify', 'validate', 'typecheck'],
  build: ['build', 'compile'],
  tests: ['test', 'tests', 'ci:test', 'test:ci', 'unit', 'integration'],
  launch: ['start', 'dev', 'run', 'ios', 'android', 'simulator'],
  pr: ['pr', 'ready', 'ready:pr', 'prepush', 'pre-push', 'ci', 'all']
};

const SCRIPT_FALLBACKS = {
  setup: ['scripts/setup.sh', 'bin/setup'],
  checks: ['scripts/check.sh', 'scripts/lint.sh'],
  build: ['scripts/build.sh'],
  tests: ['scripts/test.sh'],
  launch: ['scripts/run.sh', 'scripts/launch.sh'],
  pr: ['scripts/pr-ready.sh']
};

async function readJson(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function detectRepoRoot(inputPath) {
  const absoluteStart = path.resolve(inputPath);
  let current = absoluteStart;

  while (true) {
    const gitPath = path.join(current, '.git');
    const packagePath = path.join(current, 'package.json');
    const makefilePath = path.join(current, 'Makefile');

    if (await fileExists(gitPath) || await fileExists(packagePath) || await fileExists(makefilePath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return absoluteStart;
}

function detectPackageManager(repoRoot) {
  const choices = [
    { file: 'pnpm-lock.yaml', name: 'pnpm' },
    { file: 'yarn.lock', name: 'yarn' },
    { file: 'bun.lockb', name: 'bun' },
    { file: 'package-lock.json', name: 'npm' }
  ];

  for (const option of choices) {
    const filePath = path.join(repoRoot, option.file);
    try {
      require('fs').accessSync(filePath);
      return option.name;
    } catch {
      // Skip non-existing marker.
    }
  }

  return 'npm';
}

async function readPackageScripts(repoRoot) {
  const packageData = await readJson(path.join(repoRoot, 'package.json'));
  if (!packageData || typeof packageData !== 'object') {
    return {};
  }
  if (!packageData.scripts || typeof packageData.scripts !== 'object') {
    return {};
  }
  return packageData.scripts;
}

async function parseMakeTargets(repoRoot) {
  const makefilePath = path.join(repoRoot, 'Makefile');
  try {
    const text = await fs.readFile(makefilePath, 'utf8');
    const targets = new Set();

    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
      if (!match) {
        continue;
      }

      const target = match[1].trim();
      if (!target || target.startsWith('.')) {
        continue;
      }
      targets.add(target);
    }

    return Array.from(targets);
  } catch {
    return [];
  }
}

function pickCandidate(candidates, existsFn) {
  for (const candidate of candidates) {
    if (existsFn(candidate)) {
      return candidate;
    }
  }
  return '';
}

async function findScriptFallback(repoRoot, key) {
  const possibilities = SCRIPT_FALLBACKS[key] || [];
  for (const relPath of possibilities) {
    const absolute = path.join(repoRoot, relPath);
    if (await fileExists(absolute)) {
      return relPath;
    }
  }
  return '';
}

function commandForPackageScript(packageManager, scriptName) {
  if (packageManager === 'pnpm') {
    return {
      type: 'package-script',
      packageManager,
      command: 'pnpm',
      args: ['run', scriptName],
      display: `pnpm run ${scriptName}`
    };
  }

  if (packageManager === 'yarn') {
    return {
      type: 'package-script',
      packageManager,
      command: 'yarn',
      args: ['run', scriptName],
      display: `yarn run ${scriptName}`
    };
  }

  if (packageManager === 'bun') {
    return {
      type: 'package-script',
      packageManager,
      command: 'bun',
      args: ['run', scriptName],
      display: `bun run ${scriptName}`
    };
  }

  return {
    type: 'package-script',
    packageManager: 'npm',
    command: 'npm',
    args: ['run', scriptName],
    display: `npm run ${scriptName}`
  };
}

function appendArgs(commandSpec, extraArgs) {
  const safeExtra = Array.isArray(extraArgs) ? extraArgs.map((item) => String(item)) : [];
  if (!safeExtra.length) {
    return {
      command: commandSpec.command,
      args: commandSpec.args.slice(),
      display: commandSpec.display
    };
  }

  const finalArgs = commandSpec.args.slice();
  if (commandSpec.type === 'package-script') {
    finalArgs.push('--');
  }
  finalArgs.push(...safeExtra);

  return {
    command: commandSpec.command,
    args: finalArgs,
    display: `${commandSpec.display} ${safeExtra.join(' ')}`.trim()
  };
}

async function discoverRepository(inputPath) {
  const repoRoot = await detectRepoRoot(inputPath);
  const scripts = await readPackageScripts(repoRoot);
  const makeTargets = await parseMakeTargets(repoRoot);
  const packageManager = detectPackageManager(repoRoot);

  const commandMap = {};
  const missing = {};

  for (const key of Object.keys(CANDIDATES)) {
    const preferredScripts = CANDIDATES[key];
    const script = pickCandidate(preferredScripts, (candidate) => Object.prototype.hasOwnProperty.call(scripts, candidate));
    if (script) {
      commandMap[key] = {
        key,
        source: 'package-script',
        sourceId: script,
        ...commandForPackageScript(packageManager, script)
      };
      continue;
    }

    const target = pickCandidate(preferredScripts, (candidate) => makeTargets.includes(candidate));
    if (target) {
      commandMap[key] = {
        key,
        source: 'make-target',
        sourceId: target,
        type: 'make-target',
        command: 'make',
        args: [target],
        display: `make ${target}`
      };
      continue;
    }

    const fallbackScript = await findScriptFallback(repoRoot, key);
    if (fallbackScript) {
      commandMap[key] = {
        key,
        source: 'script-file',
        sourceId: fallbackScript,
        type: 'script-file',
        command: 'sh',
        args: [fallbackScript],
        display: `sh ${fallbackScript}`
      };
      continue;
    }

    missing[key] = {
      key,
      message: `No workflow found for '${key}'. Checked package scripts, Makefile targets, and common script files.`
    };
  }

  const hasFastlane = await fileExists(path.join(repoRoot, 'fastlane', 'Fastfile'));
  const hasGithubActions = await fileExists(path.join(repoRoot, '.github', 'workflows'));
  const hasXcodeProject = (await fs.readdir(repoRoot).catch(() => []))
    .some((entry) => entry.endsWith('.xcodeproj') || entry.endsWith('.xcworkspace'));

  const hints = [];
  if (hasFastlane) {
    hints.push('Detected fastlane configuration.');
  }
  if (hasGithubActions) {
    hints.push('Detected GitHub Actions workflows.');
  }
  if (hasXcodeProject) {
    hints.push('Detected Xcode project/workspace files.');
  }

  return {
    inputPath: path.resolve(inputPath),
    repoRoot,
    packageManager,
    scripts,
    makeTargets,
    commands: commandMap,
    missing,
    hints
  };
}

function resolveCommand(discovery, commandKey, args) {
  const definition = discovery.commands[commandKey];
  if (!definition) {
    return {
      ok: false,
      message: discovery.missing[commandKey]
        ? discovery.missing[commandKey].message
        : `Command key '${commandKey}' is not discoverable for this repository.`
    };
  }

  const withArgs = appendArgs(definition, args);
  return {
    ok: true,
    commandKey,
    source: definition.source,
    sourceId: definition.sourceId,
    command: withArgs.command,
    args: withArgs.args,
    display: withArgs.display
  };
}

module.exports = {
  discoverRepository,
  resolveCommand
};
