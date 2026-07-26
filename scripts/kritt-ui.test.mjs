import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseEnv } from './kritt-lib.mjs';
import {
  TerminalCancelledError,
  isInteractiveTerminal,
  keyToIntent,
  moveSelection,
  renderInputScreen,
  renderMenuScreen,
  runInteractiveCli,
} from './kritt-ui.mjs';

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

class ScriptedTerminal {
  constructor({ choices = [], inputs = [], throwOnChoose = null } = {}) {
    this.choices = [...choices];
    this.inputs = [...inputs];
    this.throwOnChoose = throwOnChoose;
    this.calls = [];
    this.notices = [];
  }

  async enter() {
    this.calls.push('enter');
  }

  async exit() {
    this.calls.push('exit');
  }

  async suspend() {
    this.calls.push('suspend');
  }

  async resume() {
    this.calls.push('resume');
  }

  async choose(config) {
    this.calls.push(`choose:${config.title}`);
    if (this.throwOnChoose) throw this.throwOnChoose;
    assert.notEqual(this.choices.length, 0, `unexpected choice for ${config.title}`);
    return this.choices.shift();
  }

  async readInput(config) {
    this.calls.push(`input:${config.title}`);
    assert.notEqual(this.inputs.length, 0, `unexpected input for ${config.title}`);
    return this.inputs.shift();
  }

  async notice(config) {
    this.calls.push(`notice:${config.title}`);
    this.notices.push(config);
  }

  async confirm() {
    this.calls.push('confirm');
    return true;
  }
}

async function createProject(t) {
  const rootDir = await mkdtemp(join(tmpdir(), 'open-kritt-ui-'));
  const templateFile = join(rootDir, '.env.example');
  const envFile = join(rootDir, '.env');
  await writeFile(templateFile, TEMPLATE, 'utf8');
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  return { envFile, rootDir, templateFile };
}

test('key translation supports arrows, enter, and Ctrl+C', () => {
  assert.deepEqual(keyToIntent('', { name: 'up' }), { type: 'up' });
  assert.deepEqual(keyToIntent('', { name: 'down' }), { type: 'down' });
  assert.deepEqual(keyToIntent('\r', { name: 'return' }), { type: 'enter' });
  assert.deepEqual(keyToIntent('\u0003', { ctrl: true, name: 'c' }), { type: 'cancel' });
  assert.deepEqual(keyToIntent('x', { name: 'x' }), { type: 'text', value: 'x' });
});

test('menu selection wraps around both directions', () => {
  assert.equal(moveSelection(0, 'up', 3), 2);
  assert.equal(moveSelection(2, 'down', 3), 0);
  assert.equal(moveSelection(1, 'enter', 3), 1);
});

test('screen renderers fill the requested terminal height and never reveal secret input', () => {
  const menu = renderMenuScreen({
    title: 'Welcome',
    subtitle: 'Test',
    options: [{ id: 'setup', label: 'Setup', description: 'Configure access' }],
    rows: 18,
    width: 70,
  });
  const secret = 'sk-do-not-show';
  const input = renderInputScreen({
    title: 'Codex API key',
    subtitle: 'Set credential',
    description: 'Paste a credential.',
    value: secret,
    secret: true,
    rows: 18,
    width: 70,
  });

  assert.equal(menu.split('\n').length, 18);
  assert.match(menu, /› Setup/);
  assert.equal(input.split('\n').length, 18);
  assert.doesNotMatch(input, new RegExp(secret));
  assert.match(input, /•+/);
});

test('menu details can carry semantic color without changing their text', () => {
  const screen = renderMenuScreen({
    title: 'Setup',
    subtitle: 'Status',
    details: [
      { text: '✓ Codex login present', tone: 'success' },
      { text: '○ OpenAI API key not set', tone: 'warning' },
    ],
    options: [{ id: 'back', label: 'Back' }],
    colorEnabled: true,
  });

  assert.match(screen, /\x1B\[38;5;78m✓ Codex login present/);
  assert.match(screen, /\x1B\[38;5;221m○ OpenAI API key not set/);
});

test('interactive home can open setup and save a hidden credential', async (t) => {
  const project = await createProject(t);
  const terminal = new ScriptedTerminal({
    choices: ['setup', 'CODEX_API_KEY', 'set', 'back', 'back', 'back'],
    inputs: ['sk-hidden'],
  });

  const result = await runInteractiveCli({ ...project, terminal });

  assert.deepEqual(result, { code: 0 });
  assert.equal(parseEnv(await readFile(project.envFile, 'utf8')).CODEX_API_KEY, 'sk-hidden');
  assert.deepEqual(terminal.calls.slice(0, 3), ['enter', 'choose:Welcome', 'notice:Setup']);
  assert.equal(terminal.calls.at(-1), 'exit');
});

test('interactive setup saves OpenRouter in .env and the shared managed store', async (t) => {
  const project = await createProject(t);
  const terminal = new ScriptedTerminal({
    choices: ['setup', 'OPENROUTER_API_KEY', 'set', 'back', 'back', 'back'],
    inputs: ['openrouter-hidden'],
  });

  const result = await runInteractiveCli({ ...project, terminal });
  const env = parseEnv(await readFile(project.envFile, 'utf8'));
  const store = JSON.parse(
    await readFile(join(project.rootDir, '.data', 'engine', 'credentials', 'providers.json'), 'utf8')
  );

  assert.deepEqual(result, { code: 0 });
  assert.equal(env.OPENROUTER_API_KEY, 'openrouter-hidden');
  assert.equal(store.credentials.openrouter, 'openrouter-hidden');
});

test('interactive Codex import shows a specific credential error', async (t) => {
  const project = await createProject(t);
  const terminal = new ScriptedTerminal({
    choices: ['setup', 'codex-login', 'import', 'back', 'back', 'back'],
    inputs: [join(project.rootDir, 'missing-auth.json')],
  });

  const result = await runInteractiveCli({ ...project, terminal });

  assert.deepEqual(result, { code: 0 });
  const notice = terminal.notices.find((item) => item.title === 'Import Codex login');
  assert.equal(notice.subtitle, 'Not saved');
  assert.match(notice.message, /No auth\.json was found/);
  assert.doesNotMatch(notice.message, /No readable auth\.json/);
});

test('interactive Codex login reports a failed container run without crashing', async (t) => {
  const project = await createProject(t);
  const commands = [];
  const terminal = new ScriptedTerminal({
    choices: ['setup', 'codex-login', 'login', 'back', 'back', 'back'],
  });

  const result = await runInteractiveCli({
    ...project,
    terminal,
    runner: async (command, args) => {
      commands.push({ args, command });
      return { code: args[0] === 'compose' ? 1 : 0 };
    },
  });

  assert.deepEqual(result, { code: 0 });
  const notice = terminal.notices.find((item) => item.title === 'Codex login');
  assert.equal(notice.subtitle, 'Not saved');
  assert.match(notice.message, /Codex login exited with status 1/);
  assert.deepEqual(
    commands.map(({ args }) => args.slice(0, 2)),
    [
      ['compose', 'run'],
      ['rm', '--force'],
    ]
  );
  assert.deepEqual(
    terminal.calls.filter((call) => call === 'suspend' || call === 'resume'),
    ['suspend', 'resume']
  );
});

test('interactive cancellation restores the terminal and returns signal exit code', async (t) => {
  const project = await createProject(t);
  const terminal = new ScriptedTerminal({ throwOnChoose: new TerminalCancelledError() });

  const result = await runInteractiveCli({ ...project, terminal });

  assert.deepEqual(result, { code: 130 });
  assert.deepEqual(terminal.calls, ['enter', 'choose:Welcome', 'exit']);
});

test('TTY detection rejects piped and dumb terminals', () => {
  const input = { isTTY: true, setRawMode() {} };
  const output = { isTTY: true };

  assert.equal(isInteractiveTerminal({ input, output }, 'xterm-256color'), true);
  assert.equal(isInteractiveTerminal({ input: {}, output }, 'xterm-256color'), false);
  assert.equal(isInteractiveTerminal({ input, output }, 'dumb'), false);
});
