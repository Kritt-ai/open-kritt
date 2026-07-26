import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';

import {
  CLAUDE_LOGIN,
  CODEX_LOGIN,
  ENVIRONMENT_ITEMS,
  disableManagedProviderCredential,
  UserCancelledError,
  ensureEnvFile,
  getSetupStatus,
  importCodexAuth,
  isWithinProject,
  removeCodexAuth,
  removeClaudeAuth,
  resolveHomePath,
  saveDockerCodexLogin,
  saveDockerClaudeLogin,
  saveManagedProviderCredential,
  setEnvValue,
  syncCodexLoginStatus,
} from './kritt-lib.mjs';

const ANSI = {
  accent: '\x1B[38;5;203m',
  altScreen: '\x1B[?1049h',
  clear: '\x1B[2J',
  dim: '\x1B[2m',
  hideCursor: '\x1B[?25l',
  home: '\x1B[H',
  reset: '\x1B[0m',
  restoreScreen: '\x1B[?1049l',
  success: '\x1B[38;5;78m',
  showCursor: '\x1B[?25h',
  strong: '\x1B[1m',
  warning: '\x1B[38;5;221m',
};

export class TerminalCancelledError extends Error {
  constructor() {
    super('Cancelled.');
  }
}

function defaultIo() {
  return { input: process.stdin, output: process.stdout, error: process.stderr };
}

function color(text, ansiCode, enabled) {
  return enabled ? `${ansiCode}${text}${ANSI.reset}` : text;
}

function truncate(value, width) {
  if (width <= 0) return '';
  if (value.length <= width) return value;
  return width === 1 ? '…' : `${value.slice(0, width - 1)}…`;
}

function wrap(value, width) {
  const words = value.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) {
      line = word;
      continue;
    }
    if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function fillScreen(lines, { rows = 24 } = {}) {
  const targetRows = Math.max(12, rows || 24);
  const output = lines.slice(0, targetRows);
  while (output.length < targetRows) output.push('');
  return output.join('\n');
}

function screenHeader({ title, subtitle, width, colorEnabled }) {
  const innerWidth = Math.max(20, width - 4);
  const brand = color('open·kritt', ANSI.accent, colorEnabled);
  return [
    '',
    `  ${brand}`,
    `  ${color(truncate(subtitle, innerWidth), ANSI.dim, colorEnabled)}`,
    `  ${color('─'.repeat(innerWidth), ANSI.dim, colorEnabled)}`,
    `  ${color(title, ANSI.strong, colorEnabled)}`,
    '',
  ];
}

export function moveSelection(index, intent, length) {
  if (!length) return 0;
  if (intent === 'up') return (index - 1 + length) % length;
  if (intent === 'down') return (index + 1) % length;
  return index;
}

export function keyToIntent(value, key = {}) {
  if (key.ctrl && key.name === 'c') return { type: 'cancel' };
  if (key.name === 'up') return { type: 'up' };
  if (key.name === 'down') return { type: 'down' };
  if (key.name === 'return' || key.name === 'enter') return { type: 'enter' };
  if (key.name === 'escape') return { type: 'back' };
  if (key.name === 'backspace' || key.name === 'delete') return { type: 'backspace' };
  if (value && !key.ctrl && !key.meta) return { type: 'text', value };
  return null;
}

export function renderMenuScreen({
  title,
  subtitle,
  options,
  selected = 0,
  details = [],
  footer = '↑↓ navigate   Enter select   Esc back   Ctrl+C exit',
  width = 80,
  rows = 24,
  colorEnabled = false,
}) {
  const innerWidth = Math.max(20, width - 4);
  const lines = screenHeader({ title, subtitle, width, colorEnabled });

  for (const detail of details) {
    const text = typeof detail === 'string' ? detail : detail.text;
    const tone = typeof detail === 'string' ? null : detail.tone;
    const rendered = truncate(text, innerWidth);
    lines.push(`  ${tone ? color(rendered, ANSI[tone], colorEnabled) : rendered}`);
  }
  if (details.length) lines.push('');

  for (const [index, option] of options.entries()) {
    const active = index === selected;
    const marker = active ? '›' : ' ';
    const description = option.description ? `  ${option.description}` : '';
    const text = truncate(`${marker} ${option.label}${description}`, innerWidth);
    lines.push(`  ${active ? color(text, ANSI.accent, colorEnabled) : text}`);
  }

  lines.push('');
  lines.push(`  ${color(truncate(footer, innerWidth), ANSI.dim, colorEnabled)}`);
  return fillScreen(lines, { rows });
}

export function renderInputScreen({
  title,
  subtitle,
  description,
  value,
  secret = false,
  width = 80,
  rows = 24,
  colorEnabled = false,
}) {
  const innerWidth = Math.max(20, width - 4);
  const lines = screenHeader({ title, subtitle, width, colorEnabled });
  for (const line of wrap(description, innerWidth)) lines.push(`  ${line}`);
  lines.push('');
  const displayedValue = secret ? '•'.repeat(value.length) : value;
  lines.push(
    `  ${color('› ', ANSI.accent, colorEnabled)}${truncate(displayedValue || ' ', innerWidth - 4)}${color('▌', ANSI.accent, colorEnabled)}`
  );
  lines.push('');
  lines.push(`  ${color('Enter save   Esc cancel   Ctrl+C exit', ANSI.dim, colorEnabled)}`);
  return fillScreen(lines, { rows });
}

export function renderNoticeScreen({
  title,
  subtitle,
  message,
  footer = 'Enter or Esc to continue   Ctrl+C exit',
  width = 80,
  rows = 24,
  colorEnabled = false,
}) {
  const innerWidth = Math.max(20, width - 4);
  const lines = screenHeader({ title, subtitle, width, colorEnabled });
  for (const line of wrap(message, innerWidth)) lines.push(`  ${line}`);
  lines.push('');
  lines.push(`  ${color(footer, ANSI.dim, colorEnabled)}`);
  return fillScreen(lines, { rows });
}

export function isInteractiveTerminal(io = defaultIo(), term = process.env.TERM) {
  return Boolean(io.input?.isTTY && io.output?.isTTY && typeof io.input.setRawMode === 'function' && term !== 'dumb');
}

export class FullscreenTerminal {
  constructor({ io = defaultIo(), colorEnabled = process.env.NO_COLOR === undefined } = {}) {
    this.io = io;
    this.input = io.input;
    this.output = io.output;
    this.colorEnabled = colorEnabled;
    this.active = false;
    this.intentQueue = [];
    this.intentResolver = null;
    this.keypressListener = null;
    this.rawWasEnabled = false;
  }

  dimensions() {
    return { rows: this.output.rows || 24, width: this.output.columns || 80 };
  }

  async enter() {
    if (this.active) return;
    if (!isInteractiveTerminal(this.io)) throw new Error('The interactive CLI requires a terminal.');
    this.rawWasEnabled = Boolean(this.input.isRaw);
    emitKeypressEvents(this.input);
    this.keypressListener = (value, key) => {
      const intent = keyToIntent(value, key);
      if (!intent) return;
      if (this.intentResolver) {
        const resolveIntent = this.intentResolver;
        this.intentResolver = null;
        resolveIntent(intent);
      } else {
        this.intentQueue.push(intent);
      }
    };
    this.input.on('keypress', this.keypressListener);
    if (!this.rawWasEnabled) this.input.setRawMode(true);
    this.input.resume();
    this.output.write(`${ANSI.altScreen}${ANSI.hideCursor}${ANSI.clear}${ANSI.home}`);
    this.active = true;
  }

  async exit() {
    if (!this.active) return;
    if (this.keypressListener) this.input.off('keypress', this.keypressListener);
    this.keypressListener = null;
    this.intentQueue = [];
    this.intentResolver = null;
    if (!this.rawWasEnabled && this.input.isRaw) this.input.setRawMode(false);
    this.input.pause?.();
    this.output.write(`${ANSI.showCursor}${ANSI.restoreScreen}`);
    this.active = false;
  }

  async suspend() {
    await this.exit();
  }

  async resume() {
    await this.enter();
  }

  render(content) {
    this.output.write(`${ANSI.home}${ANSI.clear}${content}`);
  }

  nextIntent() {
    if (this.intentQueue.length) return Promise.resolve(this.intentQueue.shift());
    return new Promise((resolveIntent) => {
      this.intentResolver = resolveIntent;
    });
  }

  async choose(config) {
    let selected = Math.min(Math.max(config.selected || 0, 0), Math.max(config.options.length - 1, 0));
    const render = () =>
      this.render(renderMenuScreen({ ...config, ...this.dimensions(), colorEnabled: this.colorEnabled, selected }));
    const onResize = () => render();
    this.output.on?.('resize', onResize);

    try {
      while (true) {
        render();
        const intent = await this.nextIntent();
        if (intent.type === 'cancel') throw new TerminalCancelledError();
        if (intent.type === 'back') return 'back';
        if (intent.type === 'up' || intent.type === 'down') {
          selected = moveSelection(selected, intent.type, config.options.length);
          continue;
        }
        if (intent.type === 'enter') return config.options[selected].id;
      }
    } finally {
      this.output.off?.('resize', onResize);
    }
  }

  async readInput(config) {
    let value = config.initialValue || '';
    const render = () =>
      this.render(renderInputScreen({ ...config, ...this.dimensions(), colorEnabled: this.colorEnabled, value }));
    const onResize = () => render();
    this.output.on?.('resize', onResize);

    try {
      while (true) {
        render();
        const intent = await this.nextIntent();
        if (intent.type === 'cancel') throw new TerminalCancelledError();
        if (intent.type === 'back') return null;
        if (intent.type === 'enter') return value;
        if (intent.type === 'backspace') {
          value = value.slice(0, -1);
          continue;
        }
        if (intent.type === 'text') value += intent.value.replace(/[\r\n]/g, '');
      }
    } finally {
      this.output.off?.('resize', onResize);
    }
  }

  async notice(config) {
    this.render(renderNoticeScreen({ ...config, ...this.dimensions(), colorEnabled: this.colorEnabled }));
    const intent = await this.nextIntent();
    if (intent.type === 'cancel') throw new TerminalCancelledError();
    return intent;
  }

  async confirm({ title, subtitle, message, confirmLabel }) {
    const choice = await this.choose({
      title,
      subtitle,
      details: wrap(message, Math.max(20, this.dimensions().width - 4)).map((line) => `  ${line}`),
      options: [
        { id: 'cancel', label: 'Cancel', description: 'Keep the current configuration' },
        { id: 'confirm', label: confirmLabel, description: 'Apply this change' },
      ],
      footer: '↑↓ navigate   Enter select   Esc cancel   Ctrl+C exit',
    });
    return choice === 'confirm';
  }
}

function setupContext(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  return {
    rootDir,
    envFile: options.envFile || join(rootDir, '.env'),
    templateFile: options.templateFile || join(rootDir, '.env.example'),
    homeDir: options.homeDir || homedir(),
    io: options.io || defaultIo(),
    runner: options.runner,
  };
}

function hiddenIo() {
  return {
    error: { write: () => true },
    output: { write: () => true },
  };
}

function statusDetails(status) {
  const modelAccessDetail = (text, present) => ({ text, tone: present ? 'success' : 'warning' });
  const codexLoginText = status.codexLoginPresent
    ? '✓ Codex login present (recommended)'
    : status.codexLoginIssue === 'permission'
      ? '! Codex login unreadable - fix file ownership'
      : status.codexLoginIssue
        ? '! Codex login invalid - sign in again'
        : '○ Codex login not set (recommended)';
  const details = [
    modelAccessDetail(codexLoginText, status.codexLoginPresent),
    modelAccessDetail(
      `${status.claudeLoginPresent ? '✓' : '○'} Claude login ${status.claudeLoginPresent ? 'present' : 'not set'}`,
      status.claudeLoginPresent
    ),
  ];
  details.push(
    ...ENVIRONMENT_ITEMS.slice(0, 4).map((item) => {
      const present =
        status.valuesPresent[item.key] ||
        (item.key === 'OPENROUTER_API_KEY' && status.managedProviders.includes('openrouter'));
      return modelAccessDetail(`${present ? '✓' : '○'} ${item.label} ${present ? 'present' : 'not set'}`, present);
    })
  );
  details.push(
    ...(status.managedProviders || []).map((provider) => ({
      text: `✓ ${provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Anthropic' : 'OpenRouter'} API key present (managed from Accounts)`,
      tone: 'success',
    }))
  );
  details.push({
    text: `${status.valuesPresent.GITHUB_TOKEN ? '✓' : '○'} GitHub token ${status.valuesPresent.GITHUB_TOKEN ? 'present' : 'not set'} (optional)`,
    tone: status.valuesPresent.GITHUB_TOKEN ? 'success' : 'dim',
  });
  details.push({
    text: status.providerPresent ? 'Model access configured' : 'Choose one model-access option to start',
    tone: status.providerPresent ? 'success' : 'warning',
  });
  return details;
}

async function showInfo(terminal, { title, message }) {
  await terminal.notice({ title, subtitle: 'About this option', message });
}

async function manageEnvironmentItem(terminal, context, item) {
  while (true) {
    const status = await getSetupStatus(context);
    const present =
      status.valuesPresent[item.key] ||
      (item.key === 'OPENROUTER_API_KEY' && status.managedProviders.includes('openrouter'));
    const choice = await terminal.choose({
      title: item.label,
      subtitle: present ? 'Credential is configured' : 'Credential is not configured',
      details: [item.info],
      options: [
        { id: 'set', label: present ? 'Replace credential' : 'Set credential', description: 'Input remains hidden' },
        { id: 'unset', label: 'Unset credential', description: 'Remove it from .env' },
        { id: 'info', label: 'What is this?', description: 'Read how this option is used' },
        { id: 'back', label: 'Back', description: 'Return to setup' },
      ],
    });

    if (choice === 'back') return;
    if (choice === 'info') {
      await showInfo(terminal, { title: item.label, message: item.info });
      continue;
    }
    if (choice === 'set') {
      const value = await terminal.readInput({
        title: item.label,
        subtitle: 'Set credential',
        description:
          item.key === 'OPENROUTER_API_KEY'
            ? `Paste the ${item.label}. It will be stored in .env and mirrored to the managed credential store used by running services.`
            : `Paste the ${item.label}. It will be stored in .env and is never shown in this interface.`,
        secret: true,
      });
      if (value === null) continue;
      if (!value) {
        await terminal.notice({
          title: item.label,
          subtitle: 'Nothing changed',
          message: 'Enter a value or press Esc to cancel.',
        });
        continue;
      }
      if (item.key === 'OPENROUTER_API_KEY') {
        await saveManagedProviderCredential(status.credentialsPath, 'openrouter', value);
      }
      await setEnvValue(context.envFile, item.key, value);
      await terminal.notice({
        title: item.label,
        subtitle: 'Saved',
        message: 'The credential was saved without displaying its value.',
      });
      continue;
    }
    if (
      await terminal.confirm({
        title: item.label,
        subtitle: 'Unset credential',
        message:
          item.key === 'OPENROUTER_API_KEY'
            ? `Unset ${item.label}? This removes the managed key and prevents the initial .env value from being imported again.`
            : `Unset ${item.label}? This removes the configured value from .env.`,
        confirmLabel: 'Unset credential',
      })
    ) {
      if (item.key === 'OPENROUTER_API_KEY') {
        await disableManagedProviderCredential(status.credentialsPath, 'openrouter');
      }
      await setEnvValue(context.envFile, item.key, '');
      await terminal.notice({
        title: item.label,
        subtitle: 'Unset',
        message:
          item.key === 'OPENROUTER_API_KEY'
            ? 'The credential was removed from .env and the managed store.'
            : 'The credential was removed from .env.',
      });
    }
  }
}

async function confirmExternalDestination(terminal, context, targetPath) {
  if (isWithinProject(context.rootDir, targetPath)) return true;
  return terminal.confirm({
    title: 'External login directory',
    subtitle: 'Credential destination',
    message: `The configured Codex login directory is outside this project: ${targetPath}`,
    confirmLabel: 'Save credentials there',
  });
}

async function manageCodexLogin(terminal, context) {
  while (true) {
    const status = await getSetupStatus(context);
    const targetPath = join(status.codexHome, 'auth.json');
    const defaultSource = join(context.homeDir, '.codex', 'auth.json');
    const choice = await terminal.choose({
      title: 'Codex login',
      subtitle: status.codexLoginPresent
        ? 'Login saved for this project'
        : status.codexLoginIssue === 'permission'
          ? 'Saved login needs an ownership repair'
          : 'No saved project login',
      details: [`Project login location: ${status.codexHome}`],
      options: [
        { id: 'login', label: 'Sign in with Docker', description: 'Use a device code (recommended)' },
        { id: 'import', label: 'Import local login', description: 'Copy an existing auth.json' },
        { id: 'remove', label: 'Remove saved login', description: 'Delete this project login only' },
        { id: 'info', label: 'What is this?', description: 'Read how persisted login works' },
        { id: 'back', label: 'Back', description: 'Return to setup' },
      ],
    });

    if (choice === 'back') {
      await syncCodexLoginStatus(context);
      return;
    }
    if (choice === 'info') {
      await showInfo(terminal, { title: CODEX_LOGIN.label, message: CODEX_LOGIN.info });
      continue;
    }
    if (choice === 'remove') {
      if (
        await terminal.confirm({
          title: 'Codex login',
          subtitle: 'Remove saved login',
          message: 'Remove the saved Codex login for this project?',
          confirmLabel: 'Remove login',
        })
      ) {
        const result = await removeCodexAuth(targetPath, context.rootDir);
        if (result.ok) await syncCodexLoginStatus(context);
        await terminal.notice({
          title: 'Codex login',
          subtitle: result.ok ? 'Removed' : 'Not removed',
          message: result.message,
        });
      }
      continue;
    }
    if (choice === 'import') {
      const sourcePath = await terminal.readInput({
        title: 'Import Codex login',
        subtitle: 'Source auth.json',
        description: `Enter the auth.json path, or leave it unchanged to use ${defaultSource}.`,
        initialValue: defaultSource,
      });
      if (sourcePath === null) continue;
      if (!(await confirmExternalDestination(terminal, context, dirname(targetPath)))) continue;
      const result = await importCodexAuth({
        rootDir: context.rootDir,
        sourcePath: resolveHomePath(sourcePath, context.homeDir),
        targetPath,
        io: hiddenIo(),
      });
      if (result.ok) await syncCodexLoginStatus(context);
      await terminal.notice({
        title: 'Import Codex login',
        subtitle: result.ok ? 'Saved' : 'Not saved',
        message: result.ok ? 'The local Codex login was saved for this project.' : result.message,
      });
      continue;
    }
    if (!(await confirmExternalDestination(terminal, context, dirname(targetPath)))) continue;
    await terminal.suspend();
    let result = { ok: false, message: 'Codex login did not complete.' };
    try {
      result = await saveDockerCodexLogin({
        io: context.io,
        rootDir: context.rootDir,
        runner: context.runner,
        targetPath,
        runtimeHome: status.codexRuntimeHome,
      });
    } finally {
      await terminal.resume();
    }
    if (result.ok) await syncCodexLoginStatus(context);
    await terminal.notice({
      title: 'Codex login',
      subtitle: result.ok ? 'Saved' : 'Not saved',
      message: result.ok ? 'The Codex login was saved for this project.' : result.message,
    });
  }
}

async function manageClaudeLogin(terminal, context) {
  while (true) {
    const status = await getSetupStatus(context);
    const choice = await terminal.choose({
      title: 'Claude login',
      subtitle: status.claudeLoginPresent ? 'Login saved for this project' : 'No saved project login',
      details: [`Project login location: ${status.claudeHome}`],
      options: [
        { id: 'login', label: 'Sign in with Docker', description: 'Use the official Claude browser flow' },
        { id: 'remove', label: 'Remove saved login', description: 'Sign Claude out for this project' },
        { id: 'info', label: 'What is this?', description: 'Read how persisted login works' },
        { id: 'back', label: 'Back', description: 'Return to setup' },
      ],
    });

    if (choice === 'back') return;
    if (choice === 'info') {
      await showInfo(terminal, { title: CLAUDE_LOGIN.label, message: CLAUDE_LOGIN.info });
      continue;
    }
    if (choice === 'remove') {
      if (
        await terminal.confirm({
          title: 'Claude login',
          subtitle: 'Remove saved login',
          message: 'Remove the saved Claude login for this project?',
          confirmLabel: 'Remove login',
        })
      ) {
        await removeClaudeAuth(status.claudeHome);
        await terminal.notice({
          title: 'Claude login',
          subtitle: 'Removed',
          message: 'Claude was signed out. Profile settings were preserved.',
        });
      }
      continue;
    }

    await terminal.suspend();
    let saved = false;
    try {
      saved = await saveDockerClaudeLogin({
        io: context.io,
        rootDir: context.rootDir,
        runner: context.runner,
        home: status.claudeHome,
      });
    } finally {
      await terminal.resume();
    }
    await terminal.notice({
      title: 'Claude login',
      subtitle: saved ? 'Saved' : 'Not saved',
      message: saved
        ? 'The Claude login was saved for this project.'
        : 'No login was saved. Review the login output and try again.',
    });
  }
}

async function runSetupScreen(terminal, context) {
  const created = await ensureEnvFile(context);
  if (created) {
    await terminal.notice({
      title: 'Setup',
      subtitle: 'Environment initialized',
      message: 'Created .env from .env.example. Choose one model-access option to continue.',
    });
  }
  await syncCodexLoginStatus(context);

  while (true) {
    const status = await getSetupStatus(context);
    const choice = await terminal.choose({
      title: 'Setup',
      subtitle: status.providerPresent ? 'Model access configured' : 'Choose one option to configure model access',
      details: statusDetails(status),
      options: [
        {
          id: 'codex-login',
          label: 'Codex login',
          description: status.codexLoginPresent
            ? 'recommended - present'
            : status.codexLoginIssue === 'permission'
              ? 'repair saved-login ownership'
              : 'recommended - sign in with a device code',
        },
        {
          id: 'claude-login',
          label: 'Claude login',
          description: status.claudeLoginPresent ? 'present' : 'sign in with a Claude subscription',
        },
        ...ENVIRONMENT_ITEMS.slice(0, 4).map((item) => ({
          id: item.key,
          label: item.label,
          description:
            status.valuesPresent[item.key] ||
            (item.key === 'OPENROUTER_API_KEY' && status.managedProviders.includes('openrouter'))
              ? 'present'
              : 'not set',
        })),
        {
          id: 'GITHUB_TOKEN',
          label: 'GitHub token',
          description: status.valuesPresent.GITHUB_TOKEN ? 'present' : 'optional for private repositories',
        },
        { id: 'back', label: 'Back', description: 'Return to the main menu' },
      ],
    });

    if (choice === 'back') return;
    if (choice === 'codex-login') {
      await manageCodexLogin(terminal, context);
      continue;
    }
    if (choice === 'claude-login') {
      await manageClaudeLogin(terminal, context);
      continue;
    }
    const item = ENVIRONMENT_ITEMS.find((candidate) => candidate.key === choice);
    if (item) await manageEnvironmentItem(terminal, context, item);
  }
}

async function runStartScreen(terminal, context) {
  const status = await getSetupStatus(context);
  if (!status.envExists || !status.providerPresent) {
    const choice = await terminal.choose({
      title: 'Start',
      subtitle: 'Setup is incomplete',
      details: [
        !status.envExists
          ? 'No .env file exists yet.'
          : status.codexLoginIssue === 'permission'
            ? `The saved Codex login in ${status.codexHome} is not readable by your user.`
            : 'No model provider credential or Codex login is configured.',
        'Choose one model-access option in Setup. GitHub access alone cannot run scans.',
      ],
      options: [
        { id: 'setup', label: 'Open setup', description: 'Configure model access' },
        { id: 'back', label: 'Back', description: 'Return to the main menu' },
      ],
    });
    return choice;
  }

  const choice = await terminal.choose({
    title: 'Start',
    subtitle: 'Ready to launch',
    details: ['The terminal will switch to Docker Compose. Ctrl+C there stops the running stack.'],
    options: [
      { id: 'launch', label: 'Start open-kritt', description: 'Run docker compose up --build' },
      { id: 'back', label: 'Back', description: 'Return to the main menu' },
    ],
  });
  return choice;
}

async function runHelpScreen(terminal) {
  await terminal.notice({
    title: 'Help',
    subtitle: 'open-kritt CLI',
    message:
      'Setup creates .env when needed and lets you manage provider credentials, Codex login, and optional GitHub access. Start launches Docker Compose after model access is configured. Use Arrow keys to navigate and Enter to select.',
  });
}

export async function runInteractiveCli(options = {}) {
  const context = setupContext(options);
  const terminal = options.terminal || new FullscreenTerminal({ io: context.io });
  const initialView = options.initialView || 'home';

  await terminal.enter();
  try {
    let view = initialView;
    while (true) {
      if (view === 'setup') {
        await runSetupScreen(terminal, context);
        view = 'home';
        continue;
      }
      if (view === 'help') {
        await runHelpScreen(terminal);
        view = 'home';
        continue;
      }
      if (view === 'start') {
        const result = await runStartScreen(terminal, context);
        if (result === 'launch') return { code: 0, launchStart: true };
        view = result === 'setup' ? 'setup' : 'home';
        continue;
      }

      const choice = await terminal.choose({
        title: 'Welcome',
        subtitle: 'Security research orchestration',
        details: ['Choose one model-access option in Setup, start the stack, or learn how the CLI works.'],
        options: [
          { id: 'setup', label: 'Setup', description: 'Configure provider credentials and Codex login' },
          { id: 'start', label: 'Start', description: 'Launch the Docker Compose stack' },
          { id: 'help', label: 'Help', description: 'View command guidance' },
        ],
        footer: '↑↓ navigate   Enter select   Esc or Ctrl+C exit',
      });
      if (choice === 'back') return { code: 0 };
      view = choice;
    }
  } catch (error) {
    if (error instanceof TerminalCancelledError || error instanceof UserCancelledError) {
      return { code: error.exitCode || 130 };
    }
    throw error;
  } finally {
    await terminal.exit();
  }
}
