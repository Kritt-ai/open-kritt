import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  checkDockerEnvironment,
  createPrompter,
  ensureEnvFile,
  getSetupStatus,
  importCodexAuth,
  MINIMUM_COMPOSE_VERSION,
  parseEnv,
  resolveHomePath,
  runCli,
  runCommand,
  runSetup,
  runStart,
  saveDockerClaudeLogin,
  saveDockerCodexLogin,
  setEnvValue,
  syncCodexLoginStatus,
  updateEnvText,
  UserCancelledError,
} from './kritt-lib.mjs';

const TEMPLATE = `ENGINE_CODEX_HOME_HOST=./.data/codex
CODEX_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
OPENROUTER_API_KEY=
GITHUB_TOKEN=
`;

class BufferStream {
  constructor() {
    this.text = '';
  }

  write(value) {
    this.text += value;
    return true;
  }
}

// The Docker preflight probes the daemon, the Compose plugin version, and whether Compose
// can read the project. `dockerProbes` answers those three calls so flow assertions below
// stay focused on the commands each flow runs itself.
function dockerProbes({ daemon, compose, project } = {}) {
  // A probe that fails prints its reason on stderr and nothing on stdout.
  const answer = (override = {}, stdout = '') => ({
    code: 0,
    stderr: '',
    stdout: override.code ? '' : stdout,
    ...override,
  });
  return (command, args) => {
    if (command !== 'docker') return null;
    if (args[0] === 'version') return answer(daemon, '27.3.1\n');
    if (args[0] === 'compose' && args[1] === 'version') return answer(compose, '2.29.7\n');
    if (args[0] === 'compose' && args[1] === 'config') return answer(project);
    return null;
  };
}

function dockerRunner(handler, probes = dockerProbes()) {
  return async (command, args, options) => {
    const probe = probes(command, args);
    return probe ?? handler(command, args, options);
  };
}

function testIo() {
  return { input: {}, output: new BufferStream(), error: new BufferStream() };
}

function answers({ ask = [], secret = [], confirm = [] } = {}) {
  return {
    ask: async () => {
      assert.notEqual(ask.length, 0, 'unexpected question');
      return ask.shift();
    },
    secret: async () => {
      assert.notEqual(secret.length, 0, 'unexpected secret question');
      return secret.shift();
    },
    confirm: async () => {
      assert.notEqual(confirm.length, 0, 'unexpected confirmation');
      return confirm.shift();
    },
  };
}

async function createProject(t, template = TEMPLATE) {
  const rootDir = await mkdtemp(join(tmpdir(), 'open-kritt-cli-'));
  const templateFile = join(rootDir, '.env.example');
  const envFile = join(rootDir, '.env');
  await writeFile(templateFile, template, 'utf8');
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  return { rootDir, templateFile, envFile };
}

test('setup creates a private environment file from the template', async (t) => {
  const project = await createProject(t);

  assert.equal(await ensureEnvFile(project), true);
  assert.equal(await ensureEnvFile(project), false);
  assert.equal(await readFile(project.envFile, 'utf8'), TEMPLATE);
});

test('environment updates preserve unrelated settings and replace duplicate keys', async (t) => {
  const project = await createProject(
    t,
    `# Keep this comment\nCODEX_API_KEY=old\nEXTRA_SETTING=keep\nCODEX_API_KEY=duplicate\n`
  );
  await ensureEnvFile(project);

  await setEnvValue(project.envFile, 'CODEX_API_KEY', "secret'value");
  const updated = await readFile(project.envFile, 'utf8');

  assert.match(updated, /^# Keep this comment/m);
  assert.match(updated, /^EXTRA_SETTING=keep$/m);
  assert.equal((updated.match(/^CODEX_API_KEY=/gm) || []).length, 1);
  assert.equal(parseEnv(updated).CODEX_API_KEY, "secret'value");
  assert.equal(parseEnv(updateEnvText(updated, 'CODEX_API_KEY', '')).CODEX_API_KEY, '');
});

test('environment updates replace and remove exported assignments', () => {
  const updated = updateEnvText(
    'export GITHUB_TOKEN=old-first\nKEEP=value\n  export GITHUB_TOKEN = old-second\n',
    'GITHUB_TOKEN',
    ''
  );

  assert.equal((updated.match(/^\s*(?:export\s+)?GITHUB_TOKEN\s*=/gm) || []).length, 1);
  assert.equal(parseEnv(updated).GITHUB_TOKEN, '');
  assert.equal(parseEnv(updated).KEEP, 'value');
  assert.doesNotMatch(updated, /old-first|old-second/);
});

test('status treats a saved Codex login as model access and GitHub alone as insufficient', async (t) => {
  const project = await createProject(t);
  await ensureEnvFile(project);
  await setEnvValue(project.envFile, 'GITHUB_TOKEN', 'ghp_example');

  let status = await getSetupStatus(project);
  assert.equal(status.valuesPresent.GITHUB_TOKEN, true);
  assert.equal(status.providerPresent, false);

  const codexDir = join(project.rootDir, '.data', 'codex');
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, 'auth.json'), '{}', 'utf8');

  status = await getSetupStatus(project);
  assert.equal(status.codexLoginPresent, false);
  assert.equal(status.providerPresent, false);

  await writeFile(join(codexDir, 'auth.json'), '{"tokens":{"access_token":"test"}}', 'utf8');

  status = await getSetupStatus(project);
  assert.equal(status.codexLoginPresent, true);
  assert.equal(status.providerPresent, true);
});

test('status treats a frontend-managed provider key as model access', async (t) => {
  const project = await createProject(t);
  await ensureEnvFile(project);
  const credentialsDir = join(project.rootDir, '.data', 'engine', 'credentials');
  await mkdir(credentialsDir, { recursive: true });
  await writeFile(
    join(credentialsDir, 'providers.json'),
    JSON.stringify({ version: 1, credentials: { openrouter: 'managed-secret' } })
  );

  const status = await getSetupStatus(project);
  assert.equal(status.providerPresent, true);
  assert.deepEqual(status.managedProviders, ['openrouter']);
  assert.equal(JSON.stringify(status).includes('managed-secret'), false);
});

test('start treats a saved Claude subscription login as model access', async (t) => {
  const project = await createProject(t);
  await ensureEnvFile(project);
  const claudeHome = join(project.rootDir, '.data', 'claude');
  await mkdir(claudeHome, { recursive: true });
  await writeFile(join(claudeHome, '.credentials.json'), '{"oauth":{"accessToken":"test"}}', 'utf8');
  const commands = [];

  const status = await getSetupStatus(project);
  const exitCode = await runStart({
    ...project,
    io: testIo(),
    runner: dockerRunner(async (command, args, options) => {
      commands.push({ command, args, options });
      return { code: 0 };
    }),
  });

  assert.equal(status.claudeLoginPresent, true);
  assert.equal(status.providerPresent, true);
  assert.equal(exitCode, 0);
  assert.deepEqual(commands, [
    { command: 'docker', args: ['compose', 'up', '--build'], options: { cwd: project.rootDir, stdio: 'inherit' } },
  ]);
});

test('Codex login status is synchronized as a non-secret Compose marker', async (t) => {
  const project = await createProject(t);
  await ensureEnvFile(project);
  const authPath = join(project.rootDir, '.data', 'codex', 'auth.json');
  await mkdir(join(project.rootDir, '.data', 'codex'), { recursive: true });
  await writeFile(authPath, '{"tokens":{"access_token":"test"}}', 'utf8');

  await syncCodexLoginStatus(project);
  const managedAuthPath = join(project.rootDir, '.data', 'codex-accounts', 'cli', '.codex', 'auth.json');
  assert.equal(await readFile(managedAuthPath, 'utf8'), '{"tokens":{"access_token":"test"}}');
  await assert.rejects(readFile(authPath, 'utf8'), { code: 'ENOENT' });
  assert.equal(parseEnv(await readFile(project.envFile, 'utf8')).CODEX_LOGIN_CONFIGURED, '1');

  await rm(managedAuthPath);
  await syncCodexLoginStatus(project);
  assert.equal(parseEnv(await readFile(project.envFile, 'utf8')).CODEX_LOGIN_CONFIGURED, '');
});

test('status discovers configured multi-account Codex homes through their host mount', async (t) => {
  const project = await createProject(
    t,
    `${TEMPLATE}ENGINE_CODEX_ACCOUNTS_HOST=./accounts\nENGINE_CODEX_HOME=/codex-accounts/researcher/.codex\n`
  );
  await ensureEnvFile(project);
  const accountHome = join(project.rootDir, 'accounts', 'researcher', '.codex');
  await mkdir(accountHome, { recursive: true });
  await writeFile(join(accountHome, 'auth.json'), '{"tokens":{"access_token":"test"}}', 'utf8');

  const status = await syncCodexLoginStatus(project);

  assert.equal(status.codexLoginPresent, true);
  assert.equal(status.providerPresent, true);
  assert.deepEqual(status.codexHomes, [
    join(project.rootDir, '.data', 'codex'),
    join(project.rootDir, 'accounts', 'researcher', '.codex'),
    join(project.rootDir, 'accounts', 'cli', '.codex'),
  ]);
  assert.equal(parseEnv(await readFile(project.envFile, 'utf8')).CODEX_LOGIN_CONFIGURED, '1');
});

test('setup stores a selected secret without printing it', async (t) => {
  const project = await createProject(t);
  const io = testIo();
  const secret = 'sk-not-visible-in-output';

  await runSetup({
    ...project,
    io,
    prompter: answers({ ask: ['3', '1', '8'], secret: [secret] }),
  });

  assert.equal(parseEnv(await readFile(project.envFile, 'utf8')).CODEX_API_KEY, secret);
  assert.doesNotMatch(io.output.text, new RegExp(secret));
});

test('setup stores OpenRouter in .env and the managed credential store', async (t) => {
  const project = await createProject(t);
  const io = testIo();
  const secret = 'openrouter-managed-secret';

  await runSetup({
    ...project,
    io,
    prompter: answers({ ask: ['6', '1', '8'], secret: [secret] }),
  });

  const env = parseEnv(await readFile(project.envFile, 'utf8'));
  const store = JSON.parse(
    await readFile(join(project.rootDir, '.data', 'engine', 'credentials', 'providers.json'), 'utf8')
  );
  assert.equal(env.OPENROUTER_API_KEY, secret);
  assert.equal(store.credentials.openrouter, secret);
  assert.deepEqual(store.disabledEnvironmentProviders, []);
  assert.doesNotMatch(io.output.text, new RegExp(secret));
});

test('setup migrates Codex accounts registered by the UI into .env', async (t) => {
  const project = await createProject(t);
  await ensureEnvFile(project);
  const accountHome = join(project.rootDir, '.data', 'codex-accounts', 'ui-account', '.codex');
  const runtimeConfigPath = join(project.rootDir, '.data', 'engine', 'engine-runtime.env');
  await mkdir(accountHome, { recursive: true });
  await mkdir(dirname(runtimeConfigPath), { recursive: true });
  await writeFile(join(accountHome, 'auth.json'), '{"tokens":{"access_token":"test"}}');
  await writeFile(runtimeConfigPath, 'ENGINE_CODEX_HOME=/root/.codex,/codex-accounts/ui-account/.codex\n');

  const before = await getSetupStatus(project);
  assert.equal(before.codexLoginPresent, true);
  assert.equal(before.providerPresent, true);

  const after = await syncCodexLoginStatus(project);
  const env = parseEnv(await readFile(project.envFile, 'utf8'));
  assert.equal(env.ENGINE_CODEX_HOME, '/codex-accounts/ui-account/.codex');
  assert.equal(env.CODEX_LOGIN_CONFIGURED, '1');
  assert.equal(after.codexLoginPresent, true);
});

test('status discovers Claude accounts registered by the UI through the live runtime registry', async (t) => {
  const project = await createProject(t);
  await ensureEnvFile(project);
  const accountHome = join(project.rootDir, '.data', 'claude-accounts', 'ui-account', '.claude');
  const runtimeConfigPath = join(project.rootDir, '.data', 'engine', 'engine-runtime.env');
  await mkdir(accountHome, { recursive: true });
  await mkdir(dirname(runtimeConfigPath), { recursive: true });
  await writeFile(
    join(accountHome, '.credentials.json'),
    '{"claudeAiOauth":{"accessToken":"test","refreshToken":"refresh","expiresAt":9999999999999}}'
  );
  await writeFile(runtimeConfigPath, 'ENGINE_CLAUDE_HOME=/claude-accounts/ui-account/.claude\n');

  const status = await getSetupStatus(project);

  assert.equal(status.claudeLoginPresent, true);
  assert.equal(status.providerPresent, true);
  assert.deepEqual(status.claudeHomes, [accountHome]);
});

test('guided Claude login uses the shared home monitored by Accounts', async (t) => {
  const project = await createProject(t);
  const io = testIo();
  const commands = [];
  const runner = dockerRunner(async (command, args, options) => {
    commands.push({ args, command, options });
    const home = join(project.rootDir, '.data', 'claude');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, '.credentials.json'), '{"oauth":{"accessToken":"test"}}', 'utf8');
    return { code: 0 };
  });

  await runSetup({
    ...project,
    io,
    prompter: answers({ ask: ['2', '1', '8'] }),
    runner,
  });

  assert.deepEqual(commands, [
    {
      command: 'docker',
      args: [
        'compose',
        'run',
        '--rm',
        '--no-deps',
        '--build',
        '--entrypoint',
        'claude',
        'engine',
        'auth',
        'login',
        '--claudeai',
      ],
      options: { cwd: project.rootDir, stdio: 'inherit' },
    },
  ]);
  assert.match(io.output.text, /Claude login saved/);
});

test('setup explains the optional GitHub token', async (t) => {
  const project = await createProject(t);
  const io = testIo();

  await runSetup({
    ...project,
    io,
    prompter: answers({ ask: ['7', '3', '8'] }),
  });

  assert.match(io.output.text, /private GitHub repositories/);
});

test('an existing Codex auth file is copied into the configured project home', async (t) => {
  const project = await createProject(t);
  const io = testIo();
  const homeDir = join(project.rootDir, 'home');
  const sourcePath = join(homeDir, '.codex', 'auth.json');
  const targetPath = join(project.rootDir, '.data', 'codex', 'auth.json');
  await mkdir(join(homeDir, '.codex'), { recursive: true });
  await writeFile(sourcePath, '{"tokens":{}}', 'utf8');

  assert.equal((await importCodexAuth({ rootDir: project.rootDir, sourcePath, targetPath, io })).ok, true);
  assert.equal(await readFile(targetPath, 'utf8'), '{"tokens":{}}');
  assert.equal((await stat(join(project.rootDir, '.data', 'codex'))).mode & 0o777, 0o700);
  assert.equal((await stat(targetPath)).mode & 0o777, 0o600);
  assert.equal((await importCodexAuth({ rootDir: project.rootDir, sourcePath: targetPath, targetPath, io })).ok, true);
  await writeFile(targetPath, '{}', 'utf8');
  assert.equal((await importCodexAuth({ rootDir: project.rootDir, sourcePath: targetPath, targetPath, io })).ok, false);
  assert.equal(resolveHomePath('~/.codex/auth.json', homeDir), sourcePath);
});

test('Codex auth import atomically replaces an unreadable destination', async (t) => {
  const project = await createProject(t);
  const io = testIo();
  const sourcePath = join(project.rootDir, 'auth-source.json');
  const targetDirectory = join(project.rootDir, '.data', 'codex');
  const targetPath = join(targetDirectory, 'auth.json');
  await writeFile(sourcePath, '{"tokens":{"access_token":"new"}}', { encoding: 'utf8', mode: 0o600 });
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  await writeFile(targetPath, '{"tokens":{"access_token":"old"}}', { encoding: 'utf8', mode: 0o000 });

  const result = await importCodexAuth({ sourcePath, targetPath, io });

  assert.equal(result.ok, true);
  assert.equal(await readFile(targetPath, 'utf8'), '{"tokens":{"access_token":"new"}}');
  assert.equal((await stat(targetPath)).mode & 0o777, 0o600);
});

test('Codex auth import reports an unreadable source without claiming it was saved', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root can read mode 000 files');
    return;
  }
  const project = await createProject(t);
  const io = testIo();
  const sourcePath = join(project.rootDir, 'auth-source.json');
  const targetPath = join(project.rootDir, '.data', 'codex', 'auth.json');
  await writeFile(sourcePath, '{"tokens":{"access_token":"test"}}', { encoding: 'utf8', mode: 0o000 });

  const result = await importCodexAuth({ sourcePath, targetPath, io });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'permission');
  assert.match(result.message, /not readable by your user/);
  assert.doesNotMatch(io.output.text, /saved for open-kritt/);
});

test('guided Docker login copies a host-owned auth file from an isolated container home', async (t) => {
  const project = await createProject(t);
  const io = testIo();
  const commands = [];
  const targetPath = join(project.rootDir, '.data', 'codex-accounts', 'cli', '.codex', 'auth.json');
  const runner = dockerRunner(async (command, args, options) => {
    commands.push({ args, command, options });
    if (args[0] === 'cp') {
      await writeFile(args.at(-1), '{"tokens":{"access_token":"test"}}', { encoding: 'utf8', mode: 0o600 });
    }
    return { code: 0 };
  });

  await runSetup({
    ...project,
    io,
    prompter: answers({ ask: ['1', '1', '8'] }),
    runner,
  });

  const containerName = commands[0].args[3];
  const loginSignal = commands[0].options.signal;
  assert.match(containerName, /^open-kritt-codex-login-/);
  assert.equal(loginSignal.aborted, false);
  assert.equal(commands[1].options.signal, loginSignal);
  assert.deepEqual(commands, [
    {
      command: 'docker',
      args: [
        'compose',
        'run',
        '--name',
        containerName,
        '--no-deps',
        '--build',
        '--env',
        'HOME=/open-kritt-login',
        '--env',
        'CODEX_HOME=/open-kritt-login/.codex',
        '--entrypoint',
        'sh',
        'engine',
        '-c',
        'umask 077; mkdir -p "$HOME" "$CODEX_HOME" && chmod 700 "$HOME" "$CODEX_HOME" && exec codex "$@"',
        'codex',
        'login',
        '-c',
        'cli_auth_credentials_store="file"',
        '--device-auth',
      ],
      options: { cwd: project.rootDir, signal: loginSignal, stdio: 'inherit' },
    },
    {
      command: 'docker',
      args: ['cp', `${containerName}:/open-kritt-login/.codex/auth.json`, commands[1].args.at(-1)],
      options: { cwd: project.rootDir, signal: loginSignal, stdio: 'inherit' },
    },
    {
      command: 'docker',
      args: ['rm', '--force', containerName],
      options: { cwd: project.rootDir, stdio: 'ignore' },
    },
  ]);
  assert.match(commands[1].args.at(-1), /open-kritt-codex-login-.*auth\.json$/);
  assert.equal(await readFile(targetPath, 'utf8'), '{"tokens":{"access_token":"test"}}');
  assert.equal((await stat(join(project.rootDir, '.data', 'codex-accounts', 'cli', '.codex'))).mode & 0o777, 0o700);
  assert.equal((await stat(targetPath)).mode & 0o777, 0o600);
  assert.equal((await getSetupStatus(project)).codexLoginPresent, true);
  assert.equal(parseEnv(await readFile(project.envFile, 'utf8')).CODEX_LOGIN_CONFIGURED, '1');
  assert.match(io.output.text, /Codex login saved/);
  assert.match(io.output.text, /device login/);
});

test('guided Docker login cleans up its container when copied auth is missing', async (t) => {
  const project = await createProject(t);
  const io = testIo();
  const commands = [];
  const result = await saveDockerCodexLogin({
    io,
    rootDir: project.rootDir,
    targetPath: join(project.rootDir, '.data', 'codex', 'auth.json'),
    runner: dockerRunner(async (command, args, options) => {
      commands.push({ args, command, options });
      return { code: args[0] === 'rm' ? 1 : 0 };
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing');
  assert.match(result.message, /No auth\.json was found/);
  assert.deepEqual(commands.at(-1).args.slice(0, 2), ['rm', '--force']);
  assert.match(io.error.text, /Could not confirm cleanup.*docker rm --force/);
});

for (const [interruptedSignal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  test(`guided Docker login cleans up after ${interruptedSignal}`, async (t) => {
    const project = await createProject(t);
    const io = testIo();
    const signalSource = new EventEmitter();
    const commands = [];

    await assert.rejects(
      saveDockerCodexLogin({
        io,
        rootDir: project.rootDir,
        signalSource,
        targetPath: join(project.rootDir, '.data', 'codex', 'auth.json'),
        runner: dockerRunner(async (command, args, options) => {
          commands.push({ args, command, options });
          if (args[0] === 'compose') {
            signalSource.emit(interruptedSignal);
            assert.equal(options.signal.aborted, true);
            assert.equal(options.signal.reason.signal, interruptedSignal);
            return { code: 1, signal: interruptedSignal };
          }
          return { code: 0 };
        }),
      }),
      (error) => {
        assert.ok(error instanceof UserCancelledError);
        assert.equal(error.exitCode, exitCode);
        assert.equal(error.signal, interruptedSignal);
        return true;
      }
    );

    assert.deepEqual(
      commands.map(({ args }) => args.slice(0, 2)),
      [
        ['compose', 'run'],
        ['rm', '--force'],
      ]
    );
    assert.equal(signalSource.listenerCount('SIGINT'), 0);
    assert.equal(signalSource.listenerCount('SIGTERM'), 0);
    assert.doesNotMatch(io.error.text, /login exited with status/);
  });
}

test('runCommand forwards an abort signal to its child process', async () => {
  const abortController = new AbortController();
  const running = runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    signal: abortController.signal,
    stdio: 'ignore',
  });
  setTimeout(() => abortController.abort({ signal: 'SIGTERM' }), 30);

  const result = await running;

  assert.equal(result.signal, 'SIGTERM');
});

test('start blocks GitHub-only configuration and launches Compose with model access', async (t) => {
  const project = await createProject(t);
  const io = testIo();
  await ensureEnvFile(project);
  await setEnvValue(project.envFile, 'GITHUB_TOKEN', 'ghp_example');

  let called = false;
  assert.equal(await runStart({ ...project, io, runner: async () => (called = true) }), 1);
  assert.equal(called, false);
  assert.match(io.error.text, /No model provider credential/);

  await setEnvValue(project.envFile, 'OPENAI_API_KEY', 'sk-example');
  const commands = [];
  const exitCode = await runStart({
    ...project,
    io: testIo(),
    runner: dockerRunner(async (command, args, options) => {
      commands.push({ args, command, options });
      return { code: 0 };
    }),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(commands, [
    { command: 'docker', args: ['compose', 'up', '--build'], options: { cwd: project.rootDir, stdio: 'inherit' } },
  ]);
  assert.equal((await stat(join(project.rootDir, '.data', 'codex-accounts', 'cli', '.codex'))).mode & 0o777, 0o700);
});

test('Compose configures the engine service image independently from job images', async () => {
  const compose = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const engineStart = compose.indexOf('\n  engine:\n');
  const engineEnd = compose.indexOf('\n  executor-view:\n', engineStart);

  assert.notEqual(engineStart, -1);
  assert.notEqual(engineEnd, -1);

  const engineService = compose.slice(engineStart, engineEnd);
  assert.match(engineService, /^    image: \$\{ENGINE_IMAGE:-open-kritt-engine:local\}$/m);
  assert.match(
    engineService,
    /^      ENGINE_SCAN_RUNNER_IMAGE: \$\{ENGINE_SCAN_RUNNER_IMAGE:-open-kritt-engine:local\}$/m
  );
  assert.doesNotMatch(engineService, /^    image: \$\{ENGINE_SCAN_RUNNER_IMAGE:/m);

  const environmentTemplate = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(environmentTemplate, /^ENGINE_IMAGE=open-kritt-engine:local$/m);
  assert.match(environmentTemplate, /^ENGINE_SCAN_RUNNER_IMAGE=open-kritt-engine:local$/m);
});

test('start reports how to repair a Codex home parent left unwritable by Docker', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root bypasses directory permission checks');
    return;
  }
  const project = await createProject(t);
  const io = testIo();
  await ensureEnvFile(project);
  await setEnvValue(project.envFile, 'OPENAI_API_KEY', 'sk-example');
  const dataDirectory = join(project.rootDir, '.data');
  await mkdir(dataDirectory, { recursive: true, mode: 0o500 });
  let called = false;

  try {
    assert.equal(await runStart({ ...project, io, runner: async () => (called = true) }), 1);
  } finally {
    await chmod(dataDirectory, 0o700);
  }

  assert.equal(called, false);
  assert.match(io.error.text, /older Docker login/);
  assert.match(io.error.text, new RegExp(`nearest existing project parent.*${dataDirectory}`));
  assert.doesNotMatch(io.error.text, /chown -R/);
  assert.equal(io.error.text.includes(`'${dataDirectory}'.`), false);
});

test('start repairs the mode of a host-owned Codex home', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root bypasses directory permission checks');
    return;
  }
  const project = await createProject(t);
  await ensureEnvFile(project);
  await setEnvValue(project.envFile, 'OPENAI_API_KEY', 'sk-example');
  const codexHome = join(project.rootDir, '.data', 'codex-accounts', 'cli', '.codex');
  await mkdir(dirname(codexHome), { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { mode: 0o000 });

  const exitCode = await runStart({
    ...project,
    io: testIo(),
    runner: dockerRunner(async () => ({ code: 0 })),
  });

  assert.equal(exitCode, 0);
  assert.equal((await stat(codexHome)).mode & 0o777, 0o700);
});

test('help is available for subcommands and unknown commands fail clearly', async (t) => {
  const project = await createProject(t);
  const io = testIo();

  assert.equal(await runCli(['help', 'setup'], { ...project, io }), 0);
  assert.match(io.output.text, /Creates .env from .env.example/);

  const unknownIo = testIo();
  assert.equal(await runCli(['unknown'], { ...project, io: unknownIo }), 1);
  assert.match(unknownIo.error.text, /Unknown command/);
});

test('secret prompt declines visible input by default when raw mode is unavailable', async () => {
  const input = new PassThrough();
  const output = new BufferStream();
  const prompter = createPrompter({ input, output, error: new BufferStream() });

  const pending = prompter.secret('Enter OpenRouter API key (input is hidden): ');
  input.end('no\n');

  assert.equal(await pending, '');
  assert.match(output.text, /cannot hide input/);
  assert.match(output.text, /Continue with visible input\? \[y\/N\]/);
  assert.doesNotMatch(output.text, /Enter OpenRouter API key/);
});

test('secret prompt requires consent before falling back to visible input', async () => {
  const apiKey = 'sk-or-visible-fallback';
  const input = new PassThrough();
  const output = new BufferStream();
  const prompter = createPrompter({ input, output, error: new BufferStream() });

  const pending = prompter.secret('Enter OpenRouter API key (input is hidden): ');
  input.write('yes\n');
  await new Promise((resolve) => setImmediate(resolve));
  input.end(`${apiKey}\n`);

  assert.equal(await pending, apiKey);
  assert.match(output.text, /Enter OpenRouter API key \(input will be visible\):/);
  assert.doesNotMatch(output.text, /input is hidden/);
  assert.doesNotMatch(output.text, new RegExp(apiKey));
});

test('secret prompt keeps using hidden raw-mode input when it is available', async () => {
  const apiKey = 'sk-or-hidden-input';
  const input = new EventEmitter();
  const output = new BufferStream();
  const rawModes = [];
  input.isTTY = true;
  input.resume = () => {};
  input.setRawMode = (enabled) => rawModes.push(enabled);
  const prompter = createPrompter({ input, output, error: new BufferStream() });

  const pending = prompter.secret('Enter OpenRouter API key (input is hidden): ');
  input.emit('data', Buffer.from(`${apiKey}\n`));

  assert.equal(await pending, apiKey);
  assert.deepEqual(rawModes, [true, false]);
  assert.doesNotMatch(output.text, /visible as you type/);
  assert.doesNotMatch(output.text, new RegExp(apiKey));
});

test('Docker preflight reports the daemon, the Compose version, and the project as healthy', async (t) => {
  const project = await createProject(t);
  const probes = [];

  const preflight = await checkDockerEnvironment({
    rootDir: project.rootDir,
    runner: dockerRunner(async (command, args) => {
      probes.push(args);
      return { code: 0 };
    }),
  });

  assert.deepEqual(preflight, { ok: true, issues: [], serverVersion: '27.3.1', composeVersion: '2.29.7' });
  assert.deepEqual(probes, []);
});

test('Docker preflight explains a missing docker executable', async (t) => {
  const project = await createProject(t);

  const preflight = await checkDockerEnvironment({
    rootDir: project.rootDir,
    runner: async () => {
      throw new Error('Could not run docker: spawn docker ENOENT');
    },
  });

  assert.equal(preflight.ok, false);
  assert.deepEqual(
    preflight.issues.map((issue) => issue.code),
    ['docker_missing']
  );
  assert.match(preflight.issues[0].message, /spawn docker ENOENT/);
  assert.match(preflight.issues[0].message, /Install Docker Desktop/);
});

test('start stops before Compose when the Docker daemon is unreachable', async (t) => {
  const project = await createProject(t);
  const io = testIo();
  await ensureEnvFile(project);
  await setEnvValue(project.envFile, 'OPENAI_API_KEY', 'sk-example');
  const commands = [];

  const exitCode = await runStart({
    ...project,
    io,
    runner: dockerRunner(
      async (command, args) => {
        commands.push(args);
        return { code: 0 };
      },
      dockerProbes({
        daemon: {
          code: 1,
          stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
        },
      })
    ),
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(commands, []);
  assert.match(io.error.text, /The Docker daemon is not reachable/);
  assert.match(io.error.text, /Cannot connect to the Docker daemon/);
  assert.match(io.error.text, /docker context ls/);
});

test('start stops before Compose when the Compose plugin predates the flags the CLI uses', async (t) => {
  const project = await createProject(t);
  const io = testIo();
  await ensureEnvFile(project);
  await setEnvValue(project.envFile, 'OPENAI_API_KEY', 'sk-example');
  const commands = [];

  const exitCode = await runStart({
    ...project,
    io,
    runner: dockerRunner(
      async (command, args) => {
        commands.push(args);
        return { code: 0 };
      },
      dockerProbes({ compose: { code: 0, stdout: 'v2.2.3\n' } })
    ),
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(commands, []);
  assert.match(io.error.text, new RegExp(`Docker Compose 2\\.2\\.3 is too old.*${MINIMUM_COMPOSE_VERSION} or newer`));
  assert.match(io.error.text, /docker compose run --build/);
});

test('guided Claude login reports an unreadable Compose project instead of an empty login', async (t) => {
  const project = await createProject(t);
  const io = testIo();
  const home = join(project.rootDir, '.data', 'claude');
  const commands = [];

  const saved = await saveDockerClaudeLogin({
    io,
    home,
    rootDir: project.rootDir,
    runner: dockerRunner(
      async (command, args) => {
        commands.push(args);
        return { code: 0 };
      },
      dockerProbes({
        project: {
          code: 1,
          stderr:
            'invalid interpolation format for services.backend.environment.OPEN_KRITT_CODEX_LOGIN_CONFIGURED: "${CODEX_LOGIN_CONFIGURED:+1}".\n',
        },
      })
    ),
  });

  assert.equal(saved, false);
  assert.deepEqual(commands, []);
  assert.match(io.error.text, /Docker Compose could not read this project/);
  assert.match(io.error.text, /invalid interpolation format/);
  await assert.rejects(stat(home), { code: 'ENOENT' });
});

test('guided Codex login returns a Docker environment failure with its reason', async (t) => {
  const project = await createProject(t);
  const io = testIo();
  const commands = [];

  const result = await saveDockerCodexLogin({
    io,
    rootDir: project.rootDir,
    targetPath: join(project.rootDir, '.data', 'codex', 'auth.json'),
    runner: dockerRunner(
      async (command, args) => {
        commands.push(args);
        return { code: 0 };
      },
      dockerProbes({ compose: { code: 1, stderr: "docker: 'compose' is not a docker command.\n" } })
    ),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'docker_unavailable');
  assert.match(result.message, /The Docker Compose plugin is not available/);
  assert.match(result.message, /is not a docker command/);
  assert.deepEqual(commands, []);
});
