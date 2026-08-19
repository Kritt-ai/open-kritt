import { FullscreenTerminal, renderNoticeScreen, TerminalCancelledError } from './kritt-ui.mjs';

const MAIN_MENU = Object.freeze({
  'Create scan': {
    description: 'Build and launch a scan with a guided setup',
    tone: 'accent',
  },
  'Inspect scans': {
    description: 'Review progress, errors, exports, and controls',
    tone: 'info',
  },
  'Import portable resource': {
    description: 'Add a workflow, post-script, skill, or ranker',
  },
  'Configure settings': {
    description: 'Tune live engine worker and storage settings',
  },
  'Check service health': {
    description: 'Verify the backend connection',
    tone: 'success',
  },
  Exit: { description: 'Return to your shell', tone: 'dim' },
});

const STATUS_TONES = Object.freeze({
  completed: 'success',
  failed: 'danger',
  paused: 'warning',
  pending: 'warning',
  post_processing: 'info',
  prewarming_cache: 'info',
  queued: 'warning',
  rate_limited: 'warning',
  running: 'info',
  stopped: 'danger',
});

export class HeadlessFlowCancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'HeadlessFlowCancelledError';
  }
}

export function headlessStatusTone(status) {
  return STATUS_TONES[status] || 'dim';
}

function humanize(value) {
  return `${value || ''}`.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function optionDescription(item, question) {
  if (question === 'Main menu') return MAIN_MENU[item]?.description || '';
  if (item && typeof item === 'object') {
    if (item.status) {
      const target = item.repoDisplay || item.repoFull || 'No target';
      const progress = item.progress || item.statusSummary?.progress;
      return `${target}${progress ? ` · ${progress}` : ''}`;
    }
    if (item.description) return item.description;
  }
  if (question.includes('repository kind')) {
    return item === 'local' ? 'Use a repository mounted on this host' : 'Scan a GitHub repository or URL';
  }
  if (question.includes('Model provider')) return `Run this stage through ${item}`;
  if (question.includes('Harness')) return `Execute with the ${item} agent harness`;
  if (question.includes('Thinking effort')) return `${humanize(item)} reasoning budget`;
  if (question.includes('Launch policy')) {
    return item === 'queue' ? 'Wait for active scan work to finish' : 'Launch alongside the active scan';
  }
  return '';
}

function optionTone(item, question) {
  if (question === 'Main menu') return MAIN_MENU[item]?.tone;
  if (item && typeof item === 'object' && item.status) return headlessStatusTone(item.status);
  if (item === 'Back' || item === 'Exit') return 'dim';
  return undefined;
}

function defaultSubtitle(section, baseUrl) {
  if (section === 'Command center') return `Headless scan control · connected to ${baseUrl}`;
  return `${section} · ${baseUrl}`;
}

export class FullscreenHeadlessPrompter {
  constructor({ io, baseUrl = '', terminal } = {}) {
    this.baseUrl = baseUrl;
    this.section = 'Command center';
    this.sectionSubtitle = '';
    this.nextContext = null;
    this.terminal = terminal || new FullscreenTerminal({ io });
  }

  async enter() {
    await this.terminal.enter();
  }

  async close() {
    await this.terminal.exit();
  }

  setBaseUrl(baseUrl) {
    this.baseUrl = baseUrl;
  }

  setSection(section, subtitle = '') {
    this.section = section;
    this.sectionSubtitle = subtitle;
    this.nextContext = null;
  }

  setNextContext(context) {
    this.nextContext = context;
  }

  consumeContext() {
    const context = this.nextContext || {};
    this.nextContext = null;
    return context;
  }

  currentSubtitle() {
    return this.sectionSubtitle || defaultSubtitle(this.section, this.baseUrl);
  }

  loading(message) {
    this.terminal.render(
      renderNoticeScreen({
        title: this.section,
        subtitle: this.currentSubtitle(),
        message,
        footer: 'Working…',
        ...this.terminal.dimensions(),
        colorEnabled: this.terminal.colorEnabled,
      })
    );
  }

  async notice({ title, subtitle = '', message }) {
    await this.terminal.notice({
      title,
      subtitle: subtitle || this.currentSubtitle(),
      message,
    });
  }

  async document({ title, subtitle = '', lines, footer }) {
    await this.terminal.document({
      title,
      subtitle: subtitle || this.currentSubtitle(),
      lines,
      ...(footer ? { footer } : {}),
    });
  }

  async ask(question, { defaultValue = '', required = false, secret = false } = {}) {
    const context = this.consumeContext();
    while (true) {
      const value = await this.terminal.readInput({
        title: context.title || question,
        subtitle: context.subtitle || this.currentSubtitle(),
        description: context.description || question,
        initialValue: `${defaultValue ?? ''}`,
        secret,
      });
      if (value === null) throw new HeadlessFlowCancelledError();
      const trimmed = value.trim();
      if (!required || trimmed) return trimmed || `${defaultValue ?? ''}`;
      await this.notice({
        title: 'A value is required',
        subtitle: this.section,
        message: 'Enter a value to continue, or press Esc to cancel this flow.',
      });
    }
  }

  async confirm(question, { defaultValue = false } = {}) {
    const context = this.consumeContext();
    const options = [
      { id: 'yes', label: context.confirmLabel || 'Yes, continue', description: context.confirmDescription || '' },
      { id: 'no', label: context.cancelLabel || 'No, go back', description: context.cancelDescription || '' },
    ];
    const choice = await this.terminal.choose({
      title: context.title || question,
      subtitle: context.subtitle || this.currentSubtitle(),
      details: context.details || [],
      options,
      selected: defaultValue ? 0 : 1,
      footer: '↑↓ navigate   Enter select   Esc cancel   Ctrl+C exit',
    });
    return choice === 'yes';
  }

  async select(question, items, { label = (item) => `${item}`, defaultIndex = 0 } = {}) {
    if (!items.length) throw new Error(`No options are available for: ${question}`);
    const context = this.consumeContext();
    const choice = await this.terminal.choose({
      title: context.title || (question === 'Main menu' ? 'Command center' : question),
      subtitle:
        context.subtitle ||
        (question === 'Main menu' ? defaultSubtitle('Command center', this.baseUrl) : this.currentSubtitle()),
      details: context.details || [],
      options: items.map((item, index) => ({
        id: `${index}`,
        label: label(item),
        description: optionDescription(item, question),
        tone: optionTone(item, question),
      })),
      selected: defaultIndex,
      footer:
        question === 'Main menu'
          ? '↑↓ navigate   Enter select   Esc or Ctrl+C exit'
          : '↑↓ navigate   Enter select   Esc cancel   Ctrl+C exit',
    });
    if (choice === 'back') {
      if (question === 'Main menu') return 'Exit';
      throw new HeadlessFlowCancelledError();
    }
    return items[Number(choice)];
  }

  async selectMany(question, items, { label = (item) => `${item}`, required = false } = {}) {
    if (!items.length) {
      if (required) throw new Error(`No options are available for: ${question}`);
      return [];
    }
    const context = this.consumeContext();
    const selected = await this.terminal.chooseMany({
      title: context.title || question,
      subtitle: context.subtitle || this.currentSubtitle(),
      details: context.details || [],
      options: items.map((item) => ({
        label: label(item),
        description: optionDescription(item, question),
        tone: optionTone(item, question),
      })),
      required,
    });
    if (selected === 'back') throw new HeadlessFlowCancelledError();
    return selected.map((index) => items[index]);
  }
}

export { TerminalCancelledError };
