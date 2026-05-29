const fs = require('fs/promises');
const path = require('path');
const { fileExists } = require('./utils');

const COMMAND_DEFINITIONS = {
  setup: {
    packageScripts: ['setup', 'bootstrap', 'install', 'init', 'prepare'],
    makeTargets: ['setup', 'bootstrap', 'install', 'init', 'prepare'],
    scriptPaths: [
      'scripts/harness/setup.sh',
      'Scripts/harness/setup.sh',
      'scripts/setup.sh',
      'Scripts/setup.sh',
      'bin/setup'
    ]
  },
  checks: {
    packageScripts: ['check', 'checks', 'lint', 'verify', 'validate', 'typecheck'],
    makeTargets: ['check', 'checks', 'lint', 'verify', 'validate', 'typecheck'],
    scriptPaths: [
      'scripts/harness/check.sh',
      'Scripts/harness/check.sh',
      'scripts/check.sh',
      'Scripts/check.sh',
      'scripts/lint.sh',
      'Scripts/lint.sh'
    ]
  },
  build: {
    packageScripts: ['build', 'compile', 'check', 'checks', 'verify', 'validate'],
    makeTargets: ['build', 'compile', 'check', 'checks', 'verify', 'validate'],
    scriptPaths: [
      'scripts/harness/build.sh',
      'Scripts/harness/build.sh',
      'scripts/build.sh',
      'Scripts/build.sh',
      'scripts/harness/check.sh',
      'Scripts/harness/check.sh',
      'scripts/check.sh',
      'Scripts/check.sh'
    ]
  },
  tests: {
    packageScripts: ['test', 'tests', 'ci:test', 'test:ci', 'unit', 'integration'],
    makeTargets: ['test', 'tests', 'unit', 'integration'],
    scriptPaths: [
      'scripts/harness/test.sh',
      'Scripts/harness/test.sh',
      'scripts/test.sh',
      'Scripts/test.sh'
    ]
  },
  launch: {
    packageScripts: ['start', 'dev', 'run', 'ios', 'android', 'simulator'],
    makeTargets: ['start', 'run', 'launch'],
    scriptPaths: [
      'scripts/harness/start.sh',
      'Scripts/harness/start.sh',
      'scripts/start.sh',
      'Scripts/start.sh',
      'scripts/run.sh',
      'Scripts/run.sh',
      'scripts/launch.sh',
      'Scripts/launch.sh'
    ]
  },
  pr: {
    packageScripts: ['pr', 'ready', 'ready:pr', 'prepush', 'pre-push', 'ci', 'all'],
    makeTargets: ['pr', 'ready', 'prepush', 'pre-push', 'ci', 'all'],
    scriptPaths: [
      'scripts/harness/pr-ready.sh',
      'Scripts/harness/pr-ready.sh',
      'scripts/pr-ready.sh',
      'Scripts/pr-ready.sh'
    ]
  },
  logs: {
    packageScripts: ['logs'],
    makeTargets: ['logs'],
    scriptPaths: [
      'scripts/harness/logs.sh',
      'Scripts/harness/logs.sh',
      'scripts/logs.sh',
      'Scripts/logs.sh'
    ]
  },
  doctor: {
    packageScripts: ['doctor'],
    makeTargets: ['doctor'],
    scriptPaths: [
      'scripts/harness/doctor.sh',
      'Scripts/harness/doctor.sh',
      'scripts/doctor.sh',
      'Scripts/doctor.sh'
    ]
  }
};

const RECOMMENDED_COMMAND_KEYS = ['setup', 'checks', 'build', 'tests', 'launch', 'pr'];
const REPO_ROOT_MARKERS = ['.git', 'package.json', 'Makefile', 'Package.swift', 'Package.resolved'];
const SCRIPT_DIR_CANDIDATES = ['Scripts', 'scripts'];

async function readJson(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function createRepoPathError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function validateRepositoryPath(inputPath) {
  const resolvedPath = path.resolve(inputPath);
  let stat;

  try {
    stat = await fs.stat(resolvedPath);
  } catch {
    throw createRepoPathError('repo_path_missing', `Repository path does not exist: ${resolvedPath}`);
  }

  if (!stat.isDirectory()) {
    throw createRepoPathError('repo_path_not_directory', `Repository path is not a directory: ${resolvedPath}`);
  }

  return resolvedPath;
}

async function hasXcodeProject(repoPath) {
  try {
    const entries = await fs.readdir(repoPath);
    return entries.some((entry) => entry.endsWith('.xcodeproj') || entry.endsWith('.xcworkspace'));
  } catch {
    return false;
  }
}

async function hasRepositoryMarker(repoPath) {
  for (const marker of REPO_ROOT_MARKERS) {
    if (await fileExists(path.join(repoPath, marker))) {
      return true;
    }
  }

  if (await hasXcodeProject(repoPath)) {
    return true;
  }

  if (await fileExists(path.join(repoPath, 'scripts'))) {
    return true;
  }

  return fileExists(path.join(repoPath, 'Scripts'));
}

async function detectRepoRoot(inputPath) {
  const absoluteStart = await validateRepositoryPath(inputPath);
  let current = absoluteStart;

  while (true) {
    if (await hasRepositoryMarker(current)) {
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

async function detectPackageManager(repoRoot) {
  const choices = [
    { file: 'pnpm-lock.yaml', name: 'pnpm' },
    { file: 'yarn.lock', name: 'yarn' },
    { file: 'bun.lockb', name: 'bun' },
    { file: 'package-lock.json', name: 'npm' }
  ];

  for (const option of choices) {
    if (await fileExists(path.join(repoRoot, option.file))) {
      return option.name;
    }
  }

  if (await fileExists(path.join(repoRoot, 'package.json'))) {
    return 'npm';
  }

  return null;
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

async function resolveScriptCandidate(repoRoot, candidates) {
  for (const relPath of candidates) {
    if (!(await pathExistsWithExactCase(repoRoot, relPath))) {
      continue;
    }

    const absolutePath = path.join(repoRoot, relPath);
    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) {
        continue;
      }

      const realPath = await fs.realpath(absolutePath).catch(() => absolutePath);

      return {
        relativePath: relPath,
        absolutePath: realPath,
        exists: true,
        executable: Boolean(stat.mode & 0o111)
      };
    } catch {
      // Skip missing candidates.
    }
  }

  return null;
}

async function pathExistsWithExactCase(repoRoot, relPath) {
  const segments = relPath.split('/').filter(Boolean);
  let current = repoRoot;

  for (const segment of segments) {
    let entries = [];
    try {
      entries = await fs.readdir(current);
    } catch {
      return false;
    }

    if (!entries.includes(segment)) {
      return false;
    }
    current = path.join(current, segment);
  }

  return true;
}

async function listShellScripts(repoRoot) {
  const collected = [];

  async function walkScriptsDir(relativeDir) {
    const absoluteDir = path.join(repoRoot, relativeDir);
    let entries = [];
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relPath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await walkScriptsDir(relPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.sh')) {
        continue;
      }

      const absolutePath = path.join(repoRoot, relPath);
      let stat;
      try {
        stat = await fs.stat(absolutePath);
      } catch {
        continue;
      }

      const realPath = await fs.realpath(absolutePath).catch(() => absolutePath);
      collected.push({
        relativePath: relPath.split(path.sep).join('/'),
        absolutePath: realPath,
        exists: true,
        executable: Boolean(stat.mode & 0o111)
      });
    }
  }

  for (const dirName of SCRIPT_DIR_CANDIDATES) {
    await walkScriptsDir(dirName);
  }

  return collected;
}

function commandForPackageScript(packageManager, scriptName) {
  const manager = packageManager || 'npm';
  return {
    type: manager,
    path: manager,
    exists: true,
    executable: true,
    command: manager,
    args: ['run', scriptName],
    display: `${manager} run ${scriptName}`
  };
}

function commandForMakeTarget(target) {
  return {
    type: 'make',
    path: 'make',
    exists: true,
    executable: true,
    command: 'make',
    args: [target],
    display: `make ${target}`
  };
}

function commandForScriptFile(scriptInfo) {
  return {
    type: 'script',
    path: scriptInfo.absolutePath,
    relativePath: scriptInfo.relativePath,
    exists: true,
    executable: scriptInfo.executable,
    command: scriptInfo.absolutePath,
    args: [],
    display: `./${scriptInfo.relativePath}`
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
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(commandSpec.type)) {
    finalArgs.push('--');
  }
  finalArgs.push(...safeExtra);

  return {
    command: commandSpec.command,
    args: finalArgs,
    display: `${commandSpec.display} ${safeExtra.join(' ')}`.trim()
  };
}

function classifyRepoType(signals) {
  const families = [];
  if (signals.hasNodeMetadata) {
    families.push('node');
  }
  if (signals.hasSwiftPackage) {
    families.push('swift');
  }
  if (signals.hasXcodeProject) {
    families.push('xcode');
  }

  if (families.length > 1) {
    return 'mixed';
  }
  if (families.length === 1) {
    return families[0];
  }
  return 'unknown';
}

function buildMissingCommand(key, definition) {
  const checkedPaths = definition.scriptPaths.slice();
  const checkedSources = [];

  if (definition.packageScripts.length) {
    checkedSources.push(`package scripts: ${definition.packageScripts.join(', ')}`);
  }
  if (definition.makeTargets.length) {
    checkedSources.push(`Make targets: ${definition.makeTargets.join(', ')}`);
  }
  if (checkedPaths.length) {
    checkedSources.push(`script paths: ${checkedPaths.join(', ')}`);
  }

  return {
    key,
    checkedPaths,
    message: `No workflow found for '${key}'. This command matters because the bridge can only run discovered workflows. Add one of the expected scripts or matching package/make commands, then retry. Checked ${checkedSources.join('; ')}.`
  };
}

async function discoverRepository(inputPath) {
  const repoRoot = await detectRepoRoot(inputPath);
  const scripts = await readPackageScripts(repoRoot);
  const makeTargets = await parseMakeTargets(repoRoot);
  const shellScripts = await listShellScripts(repoRoot);
  const packageManager = await detectPackageManager(repoRoot);
  const hasSwiftPackage = await fileExists(path.join(repoRoot, 'Package.swift'));
  const hasGithubActions = await fileExists(path.join(repoRoot, '.github', 'workflows'));
  const hasFastlane = await fileExists(path.join(repoRoot, 'fastlane', 'Fastfile'));
  const xcodeProjectPresent = await hasXcodeProject(repoRoot);
  const hasLowerScripts = await fileExists(path.join(repoRoot, 'scripts'));
  const hasUpperScripts = await fileExists(path.join(repoRoot, 'Scripts'));
  const repoType = classifyRepoType({
    hasNodeMetadata: Boolean(packageManager),
    hasSwiftPackage,
    hasXcodeProject: xcodeProjectPresent
  });

  const commandMap = {};
  const missing = {};

  for (const [key, definition] of Object.entries(COMMAND_DEFINITIONS)) {
    const packageScript = pickCandidate(
      definition.packageScripts,
      (candidate) => Object.prototype.hasOwnProperty.call(scripts, candidate)
    );
    if (packageScript) {
      commandMap[key] = {
        key,
        source: 'package-script',
        sourceId: packageScript,
        ...commandForPackageScript(packageManager, packageScript)
      };
      continue;
    }

    const makeTarget = pickCandidate(definition.makeTargets, (candidate) => makeTargets.includes(candidate));
    if (makeTarget) {
      commandMap[key] = {
        key,
        source: 'make-target',
        sourceId: makeTarget,
        ...commandForMakeTarget(makeTarget)
      };
      continue;
    }

    const scriptFile = await resolveScriptCandidate(repoRoot, definition.scriptPaths);
    if (scriptFile) {
      commandMap[key] = {
        key,
        source: 'script-file',
        sourceId: scriptFile.relativePath,
        discovered: true,
        ...commandForScriptFile(scriptFile)
      };
      continue;
    }

    missing[key] = buildMissingCommand(key, definition);
  }

  for (const scriptFile of shellScripts) {
    const scriptName = path.basename(scriptFile.relativePath, '.sh');
    if (!scriptName || commandMap[scriptName]) {
      continue;
    }

    commandMap[scriptName] = {
      key: scriptName,
      source: 'script-file',
      sourceId: scriptFile.relativePath,
      discovered: true,
      ...commandForScriptFile(scriptFile)
    };
  }

  const hints = [];
  if (hasSwiftPackage) {
    hints.push('Detected a Swift package manifest.');
  }
  if (xcodeProjectPresent) {
    hints.push('Detected Xcode project/workspace files.');
  }
  if (hasFastlane) {
    hints.push('Detected fastlane configuration.');
  }
  if (hasGithubActions) {
    hints.push('Detected GitHub Actions workflows.');
  }
  if (hasLowerScripts) {
    hints.push('Detected shell scripts under scripts/.');
  }
  if (hasUpperScripts) {
    hints.push('Detected shell scripts under Scripts/.');
  }
  if (!Object.keys(commandMap).length) {
    hints.push('No recognized repo workflows were discovered.');
  }

  return {
    inputPath: path.resolve(inputPath),
    repoRoot,
    repoType,
    packageManager: packageManager || 'unknown',
    scripts,
    shellScripts: shellScripts.map((item) => item.relativePath),
    makeTargets,
    commands: commandMap,
    missing,
    missingRecommended: RECOMMENDED_COMMAND_KEYS.filter((key) => !commandMap[key]),
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

  if (definition.type === 'script' && !definition.executable) {
    return {
      ok: false,
      message: `Workflow '${commandKey}' was found at '${definition.relativePath}', but it is not executable. This matters because the bridge runs script workflows directly. Fix it with 'chmod +x ${definition.relativePath}' and retry.`
    };
  }

  const withArgs = appendArgs(definition, args);
  return {
    ok: true,
    commandKey,
    source: definition.source,
    sourceId: definition.sourceId,
    type: definition.type,
    path: definition.path,
    relativePath: definition.relativePath || '',
    exists: definition.exists,
    executable: definition.executable,
    discovered: Boolean(definition.discovered),
    command: withArgs.command,
    args: withArgs.args,
    display: withArgs.display
  };
}

module.exports = {
  discoverRepository,
  resolveCommand
};
