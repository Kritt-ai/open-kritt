import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline/promises';

import { parseResourceImport, RESOURCE_IMPORT_MAX_BYTES } from '../frontend/src/lib/resourceTransfer.js';
import { parseWorkflowImport, WORKFLOW_IMPORT_MAX_BYTES } from '../frontend/src/lib/workflowTransfer.js';
import {
  FullscreenHeadlessPrompter,
  HeadlessFlowCancelledError,
  headlessStatusTone,
  TerminalCancelledError,
} from './kritt-headless-ui.mjs';
import { isInteractiveTerminal } from './kritt-ui.mjs';

const PROVIDER_HARNESSES = Object.freeze({
  codex: ['codex'],
  claude: ['claude-code'],
  openrouter: ['claude-code', 'codex'],
});
const PROVIDER_EFFORTS = Object.freeze({
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  openrouter: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
});
const HARNESS_EFFORTS = Object.freeze({
  codex: ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'claude-code': ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
});
const RESOURCE_IMPORTS = Object.freeze({
  workflow: Object.freeze({
    endpoint: '/workflows',
    label: 'workflow',
    maxBytes: WORKFLOW_IMPORT_MAX_BYTES,
    parse: parseWorkflowImport,
  }),
  'post-script': Object.freeze({
    endpoint: '/post-scripts',
    label: 'post-script',
    maxBytes: RESOURCE_IMPORT_MAX_BYTES,
    parse: (contents) => parseResourceImport('postScript', contents),
  }),
  skill: Object.freeze({
    endpoint: '/agent-skills',
    label: 'agent skill',
    maxBytes: RESOURCE_IMPORT_MAX_BYTES,
    parse: (contents) => parseResourceImport('agentSkill', contents),
  }),
  ranker: Object.freeze({
    endpoint: '/severity-rankers',
    label: 'severity ranker',
    maxBytes: RESOURCE_IMPORT_MAX_BYTES,
    parse: (contents) => parseResourceImport('severityRanker', contents),
  }),
});
const SCAN_ACTIONS = Object.freeze({
  pause: 'paused',
  resume: 'pending',
  stop: 'stopped',
});
const SCAN_LIST_STATUSES = new Set([
  'all',
  'running',
  'queued',
  'pending',
  'prewarming_cache',
  'rate_limited',
  'paused',
  'post_processing',
  'completed',
  'stopped',
  'failed',
]);

function defaultIo() {
  return { input: process.stdin, output: process.stdout, error: process.stderr };
}

function write(io, message = '') {
  io.output.write(`${message}\n`);
}

function writeError(io, message = '') {
  io.error.write(`${message}\n`);
}

function setSection(prompter, section, subtitle = '') {
  prompter.setSection?.(section, subtitle);
}

function showLoading(prompter, io, message) {
  if (prompter.loading) prompter.loading(message);
  else write(io, message);
}

function setNextContext(prompter, context) {
  if (!prompter.setNextContext) return false;
  prompter.setNextContext(context);
  return true;
}

async function presentNotice(prompter, io, { title, subtitle = '', message }) {
  if (prompter.notice) await prompter.notice({ title, subtitle, message });
  else write(io, message);
}

async function presentDocument(prompter, io, { title, subtitle = '', lines, footer }) {
  if (prompter.document) await prompter.document({ title, subtitle, lines, footer });
  else write(io, lines.map((line) => (typeof line === 'string' ? line : line.text)).join('\n'));
}

function scanDocumentLines(scan, { detailed = false } = {}) {
  return formatScanSummary(scan, { detailed })
    .split('\n')
    .map((text, index) => (index === 0 ? { text, tone: headlessStatusTone(scan.status) } : text));
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isObjectMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseEnvironmentText(text) {
  const values = {};
  for (const line of `${text || ''}`.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export async function resolveHeadlessApiBase({ rootDir, env = process.env, apiUrl } = {}) {
  let projectEnvironment = {};
  if (rootDir) {
    try {
      projectEnvironment = parseEnvironmentText(await readFile(join(rootDir, '.env'), 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const configured = `${apiUrl || env.OPEN_KRITT_API_URL || ''}`.trim();
  const rawBase = configured || `http://127.0.0.1:${projectEnvironment.BACKEND_PORT || '3002'}`;
  let parsed;
  try {
    parsed = new URL(rawBase);
  } catch {
    throw new Error(`Invalid API URL: ${rawBase}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('The API URL must use http or https.');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  if (!parsed.pathname.endsWith('/api')) parsed.pathname = `${parsed.pathname}/api`.replace(/\/+/g, '/');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

export class HeadlessApiError extends Error {
  constructor(message, status, { errors = [], code = null, data = null } = {}) {
    super(message);
    this.name = 'HeadlessApiError';
    this.status = status;
    this.errors = errors;
    this.code = code;
    this.data = data;
  }
}

async function errorResponse(response) {
  let data = null;
  try {
    data = await response.json();
  } catch {
    // A proxy or interrupted backend can return a non-JSON error.
  }
  return new HeadlessApiError(data?.error || `Request failed (${response.status})`, response.status, {
    errors: Array.isArray(data?.errors) ? data.errors : [],
    code: data?.code || null,
    data,
  });
}

export class HeadlessApiClient {
  constructor({ baseUrl, fetchImpl = fetch } = {}) {
    this.baseUrl = `${baseUrl || ''}`.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = 'GET', body, headers = {}, cache = 'no-store' } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        cache,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(`Could not reach open-kritt at ${this.baseUrl}: ${error.message}`);
    }
    if (!response.ok) throw await errorResponse(response);
    if (response.status === 204) return null;
    return response.json();
  }

  health() {
    return this.request('/health');
  }

  workflows() {
    return this.request('/workflows');
  }

  postScripts() {
    return this.request('/post-scripts');
  }

  agentSkills() {
    return this.request('/agent-skills');
  }

  severityRankers() {
    return this.request('/severity-rankers');
  }

  localRepos() {
    return this.request('/local-repos');
  }

  modelProviders() {
    return this.request('/model-providers');
  }

  modelCatalog() {
    return this.request('/model-catalog');
  }

  scans(status = 'all') {
    return this.request(`/scans${status && status !== 'all' ? `?status=${encodeURIComponent(status)}` : ''}`);
  }

  scan(id) {
    return this.request(`/scans/${encodeURIComponent(id)}`);
  }

  createScan(body) {
    return this.request('/scans', { method: 'POST', body });
  }

  updateScan(id, body) {
    return this.request(`/scans/${encodeURIComponent(id)}`, { method: 'PATCH', body });
  }

  settings() {
    return this.request('/settings');
  }

  updateSettings(body) {
    return this.request('/settings', { method: 'PATCH', body });
  }

  importResource(endpoint, body) {
    return this.request(endpoint, { method: 'POST', body });
  }

  async downloadScanExport(id, destinationPath, { overwrite = false } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/scans/${encodeURIComponent(id)}/export`, {
        cache: 'no-store',
      });
    } catch (error) {
      throw new Error(`Could not reach open-kritt at ${this.baseUrl}: ${error.message}`);
    }
    if (!response.ok) throw await errorResponse(response);

    const header = response.headers.get('content-disposition');
    const serverFilename = attachmentFilename(header, `scan-${id}-findings.zip`);
    const outputPath = await resolveExportDestination(destinationPath, serverFilename);
    if (!overwrite && (await pathExists(outputPath))) {
      throw new Error(`Refusing to overwrite existing export: ${outputPath}`);
    }
    await mkdir(dirname(outputPath), { recursive: true });
    const temporaryPath = join(dirname(outputPath), `.${basename(outputPath)}.${randomUUID()}.tmp`);
    try {
      if (!response.body) throw new Error('The export response did not include a file body.');
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
      await rename(temporaryPath, outputPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
    return outputPath;
  }
}

function safeFilename(value, fallback) {
  const filename = [...`${value || ''}`]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('')
    .split(/[\\/]/)
    .pop()
    .trim();
  return filename || fallback;
}

export function attachmentFilename(contentDisposition, fallback = 'download.zip') {
  const header = `${contentDisposition || ''}`;
  const encoded = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return safeFilename(decodeURIComponent(encoded.trim()), fallback);
    } catch {
      // Fall through to the plain filename parameter.
    }
  }
  const quoted = header.match(/filename\s*=\s*"((?:[^"\\]|\\.)*)"/i)?.[1];
  if (quoted) return safeFilename(quoted.replace(/\\(["\\])/g, '$1'), fallback);
  const plain = header.match(/filename\s*=\s*([^;]+)/i)?.[1];
  return safeFilename(plain?.trim(), fallback);
}

async function resolveExportDestination(requestedPath, serverFilename) {
  const candidate = resolve(requestedPath || '.');
  try {
    const candidateStat = await stat(candidate);
    return candidateStat.isDirectory() ? join(candidate, serverFilename) : candidate;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return extname(candidate).toLowerCase() === '.zip' ? candidate : join(candidate, serverFilename);
}

export class HeadlessPrompter {
  constructor({ io = defaultIo() } = {}) {
    this.io = io;
    this.readline = createInterface({ input: io.input, output: io.output });
  }

  close() {
    this.readline.close();
  }

  async ask(question, { defaultValue = '', required = false } = {}) {
    while (true) {
      const suffix = defaultValue !== '' && defaultValue !== null ? ` [${defaultValue}]` : '';
      const answer = (await this.readline.question(`${question}${suffix}: `)).trim();
      const value = answer || `${defaultValue ?? ''}`;
      if (!required || value.trim()) return value;
      write(this.io, 'A value is required.');
    }
  }

  async confirm(question, { defaultValue = false } = {}) {
    const marker = defaultValue ? 'Y/n' : 'y/N';
    while (true) {
      const answer = (await this.readline.question(`${question} [${marker}]: `)).trim().toLowerCase();
      if (!answer) return defaultValue;
      if (['y', 'yes'].includes(answer)) return true;
      if (['n', 'no'].includes(answer)) return false;
      write(this.io, 'Enter y or n.');
    }
  }

  async select(question, items, { label = (item) => `${item}`, defaultIndex = 0 } = {}) {
    if (!items.length) throw new Error(`No options are available for: ${question}`);
    write(this.io, question);
    items.forEach((item, index) => write(this.io, `  ${index + 1}. ${label(item)}`));
    while (true) {
      const answer = await this.ask('Choose', { defaultValue: `${defaultIndex + 1}`, required: true });
      if (/^\d+$/.test(answer)) {
        const index = Number(answer) - 1;
        if (items[index] !== undefined) return items[index];
      }
      write(this.io, `Choose a number from 1 to ${items.length}.`);
    }
  }

  async selectMany(question, items, { label = (item) => `${item}`, required = false } = {}) {
    if (!items.length) {
      if (required) throw new Error(`No options are available for: ${question}`);
      return [];
    }
    write(this.io, question);
    items.forEach((item, index) => write(this.io, `  ${index + 1}. ${label(item)}`));
    while (true) {
      const answer = await this.ask(
        required ? 'Choose one or more numbers (comma-separated)' : 'Choose numbers (comma-separated, blank for none)'
      );
      if (!answer && !required) return [];
      const indexes = [...new Set(answer.split(',').map((part) => Number(part.trim()) - 1))];
      if (indexes.length && indexes.every((index) => Number.isInteger(index) && items[index] !== undefined)) {
        return indexes.map((index) => items[index]);
      }
      write(this.io, `Choose comma-separated numbers from 1 to ${items.length}.`);
    }
  }
}

async function readTextValue(value, { rootDir, label = 'value' } = {}) {
  if (!value.startsWith('@')) return value;
  const requestedPath = value.slice(1).trim();
  if (!requestedPath) throw new Error(`Provide a file path after @ for ${label}.`);
  const path = isAbsolute(requestedPath) ? requestedPath : resolve(rootDir, requestedPath);
  return readFile(path, 'utf8');
}

function catalogByProvider(payload) {
  const result = new Map();
  for (const entry of Array.isArray(payload?.providers) ? payload.providers : []) {
    if (isObjectMap(entry) && typeof entry.provider === 'string') result.set(entry.provider, entry);
  }
  return result;
}

function configuredProviders(payload) {
  const source = Array.isArray(payload) ? payload : payload?.providers;
  return Array.isArray(source) ? source.filter((provider) => PROVIDER_HARNESSES[provider]) : [];
}

function modelEfforts(provider, harness, model, catalog) {
  const listed = (Array.isArray(catalog?.models) ? catalog.models : []).find((candidate) => candidate?.id === model);
  const candidates =
    Array.isArray(listed?.thinkingEfforts) && listed.thinkingEfforts.length
      ? listed.thinkingEfforts
      : PROVIDER_EFFORTS[provider] || [];
  return candidates.filter((effort) => HARNESS_EFFORTS[harness]?.includes(effort));
}

async function chooseModelSelection(prompter, providers, catalogs, { prefix = '', fallback = null } = {}) {
  const provider = await prompter.select(`${prefix}Model provider`, providers, {
    label: (value) => value,
    defaultIndex: Math.max(0, providers.indexOf(fallback?.model_provider)),
  });
  const harnesses = PROVIDER_HARNESSES[provider];
  const harness = await prompter.select(`${prefix}Harness`, harnesses, {
    label: (value) => value,
    defaultIndex: Math.max(0, harnesses.indexOf(fallback?.harness)),
  });
  const catalog = catalogs.get(provider) || {};
  const models = Array.isArray(catalog.models) ? catalog.models.filter((model) => model?.id) : [];
  let model;
  if (catalog.input === 'text' || provider === 'openrouter') {
    model = await prompter.ask(`${prefix}Exact model ID`, {
      defaultValue: fallback?.model || catalog.defaultModel || models[0]?.id || '',
      required: true,
    });
  } else {
    if (catalog.status !== 'ready' || models.length === 0) {
      throw new Error(`The ${provider} model catalog is not ready. Wait for the engine to refresh it and try again.`);
    }
    const selected = await prompter.select(`${prefix}Model`, models, {
      label: (candidate) =>
        candidate.label && candidate.label !== candidate.id ? `${candidate.label} (${candidate.id})` : candidate.id,
      defaultIndex: Math.max(
        0,
        models.findIndex((candidate) => candidate.id === (fallback?.model || catalog.defaultModel))
      ),
    });
    model = selected.id;
  }
  const efforts = modelEfforts(provider, harness, model, catalog);
  if (!efforts.length) throw new Error(`No thinking efforts are available for ${provider}/${model}/${harness}.`);
  const thinkingEffort = await prompter.select(`${prefix}Thinking effort`, efforts, {
    label: (value) => value,
    defaultIndex: Math.max(0, efforts.indexOf(fallback?.thinking_effort || 'medium')),
  });
  return { model, model_provider: provider, harness, thinking_effort: thinkingEffort };
}

export function requiredExtraKeys(workflow, postScripts) {
  const keys = new Set(Array.isArray(workflow?.extra) ? workflow.extra : []);
  for (const postScript of postScripts || []) {
    const content = typeof postScript?.content === 'string' ? postScript.content : '';
    for (const match of content.matchAll(/\{\{\s*extra\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) keys.add(match[1]);
  }
  return [...keys];
}

function workflowDepths(workflow) {
  if (Array.isArray(workflow?.depths))
    return [...new Set(workflow.depths.filter(Number.isInteger))].sort((a, b) => a - b);
  return [...new Set((workflow?.steps || []).map((step) => step.depth).filter(Number.isInteger))].sort((a, b) => a - b);
}

async function chooseDependencies(prompter, localRepos) {
  const dependencies = [];
  while (await prompter.confirm('Add a dependency repository?', { defaultValue: false })) {
    const kind = await prompter.select('Dependency kind', ['remote', 'local']);
    if (kind === 'local') {
      if (!localRepos.length) throw new Error('No local repositories are available.');
      const repository = await prompter.select('Local dependency', localRepos, { label: (item) => item.name });
      dependencies.push({ kind: 'local', repo_full: repository.name, commit_sha: null });
    } else {
      const repoFull = await prompter.ask('GitHub dependency (owner/repo or URL)', { required: true });
      const commitSha = await prompter.ask('Dependency revision', { defaultValue: 'HEAD', required: true });
      dependencies.push({ kind: 'remote', repo_full: repoFull, commit_sha: commitSha });
    }
  }
  return dependencies;
}

export async function createScanInteractively({ client, prompter, io = defaultIo(), rootDir = process.cwd() }) {
  setSection(prompter, 'Create scan', 'Guided scan setup');
  showLoading(prompter, io, 'Loading workflows, models, and reusable scan resources…');
  const [workflows, postScripts, agentSkills, severityRankers, localRepos, providerPayload, catalogPayload] =
    await Promise.all([
      client.workflows(),
      client.postScripts(),
      client.agentSkills(),
      client.severityRankers(),
      client.localRepos(),
      client.modelProviders(),
      client.modelCatalog(),
    ]);

  if (!workflows.length) throw new Error('No workflows are available. Import one before creating a scan.');
  if (!postScripts.length) throw new Error('No post-scripts are available. Import one before creating a scan.');
  const providers = configuredProviders(providerPayload);
  if (!providers.length)
    throw new Error('No model provider is configured. Run ./kritt setup or configure Accounts first.');
  const catalogs = catalogByProvider(catalogPayload);

  // Resource selections intentionally come first: together they define every
  // extra.* input that must be collected before the scan can be approved.
  const workflow = await prompter.select('Workflow', workflows, {
    label: (item) => `${item.name} (${item.stepCount} steps)`,
  });
  const selectedPostScripts = await prompter.selectMany('Post-scripts', postScripts, {
    label: (item) => item.name,
    required: true,
  });
  const extra = {};
  for (const key of requiredExtraKeys(workflow, selectedPostScripts)) {
    const raw = await prompter.ask(`Required extra.${key} (prefix a path with @ to read a file)`, { required: true });
    extra[key] = await readTextValue(raw, { rootDir, label: `extra.${key}` });
    if (!extra[key].trim()) throw new Error(`extra.${key} cannot be empty.`);
  }

  const repoKind = await prompter.select('Target repository kind', ['remote', 'local']);
  let repoFull;
  let commitSha;
  if (repoKind === 'local') {
    if (!localRepos.length) throw new Error('No local repositories are available under LOCAL_REPOS_PATH.');
    const repository = await prompter.select('Local target repository', localRepos, {
      label: (item) => `${item.name}${item.branch ? ` (${item.branch}${item.commit ? ` ${item.commit}` : ''})` : ''}`,
    });
    repoFull = repository.name;
  } else {
    repoFull = await prompter.ask('GitHub target (owner/repo or URL)', { required: true });
    commitSha = await prompter.ask('Target revision', { defaultValue: 'HEAD', required: true });
  }
  const repoScope = await prompter.ask('Repository scope', { defaultValue: 'full repository', required: true });
  const dependencies = await chooseDependencies(prompter, localRepos);

  const configurationText = await prompter.ask('Configuration JSON (or @path)', {
    defaultValue: '{"max_files":4000,"include_tests":false}',
    required: true,
  });
  const configurationSource = await readTextValue(configurationText, { rootDir, label: 'configuration' });
  let configuration;
  try {
    configuration = JSON.parse(configurationSource);
  } catch {
    throw new Error('Configuration must be valid JSON.');
  }
  if (!isObjectMap(configuration)) throw new Error('Configuration JSON must be an object.');

  const jobLimitText = await prompter.ask('Maximum model jobs (blank for unlimited)');
  let jobLimit = null;
  if (jobLimitText) {
    if (!/^\d+$/.test(jobLimitText) || Number(jobLimitText) < 1 || Number(jobLimitText) > 1_000_000) {
      throw new Error('Maximum model jobs must be a whole number from 1 to 1,000,000.');
    }
    jobLimit = Number(jobLimitText);
  }

  const baseModel = await chooseModelSelection(prompter, providers, catalogs);
  let postProcessing = { ...baseModel };
  if (await prompter.confirm('Use a different model for post-processing?', { defaultValue: false })) {
    postProcessing = await chooseModelSelection(prompter, providers, catalogs, { prefix: 'Post-processing ' });
  } else {
    const efforts = modelEfforts(
      baseModel.model_provider,
      baseModel.harness,
      baseModel.model,
      catalogs.get(baseModel.model_provider)
    );
    postProcessing.thinking_effort = await prompter.select('Post-processing thinking effort', efforts, {
      defaultIndex: Math.max(0, efforts.indexOf(baseModel.thinking_effort)),
    });
  }

  const modelOverrides = {};
  const depths = workflowDepths(workflow);
  if (
    depths.length &&
    (await prompter.confirm('Customize the model for individual workflow depths?', { defaultValue: false }))
  ) {
    for (const depth of depths) {
      if (!(await prompter.confirm(`Override depth ${depth}?`, { defaultValue: false }))) continue;
      modelOverrides[depth] = await chooseModelSelection(prompter, providers, catalogs, {
        prefix: `Depth ${depth} `,
        fallback: baseModel,
      });
    }
  }

  const selectedSkills = await prompter.selectMany('Agent skills (optional)', agentSkills, {
    label: (item) => `${item.name} (${item.slug})`,
  });
  const selectedRankers = await prompter.selectMany(
    'Severity rankers (custom rules can be added next)',
    severityRankers,
    {
      label: (item) => `${item.name}${item.isDefault ? ' [default]' : ''}`,
    }
  );
  const customRankerInput = await prompter.ask('Additional severity rules (optional; prefix a path with @)');
  const customRanker = customRankerInput
    ? await readTextValue(customRankerInput, { rootDir, label: 'severity rules' })
    : '';
  const severityRanker = [...selectedRankers.map((ranker) => ranker.content), customRanker]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())
    .join('\n\n');
  if (!severityRanker) throw new Error('Select at least one severity ranker or provide custom severity rules.');

  const postScriptIds = selectedPostScripts.map((postScript) => postScript.id);
  configuration = {
    ...configuration,
    post_script_ids: postScriptIds,
    agent_skill_ids: selectedSkills.map((skill) => skill.id),
  };
  const payload = {
    workflowId: workflow.id,
    postScriptId: postScriptIds[0],
    agentSkillIds: selectedSkills.map((skill) => skill.id),
    repo_kind: repoKind,
    repo_full: repoFull,
    ...(repoKind === 'remote' ? { commit_sha: commitSha } : {}),
    repo_scope: repoScope,
    dependencies,
    configuration,
    ...baseModel,
    post_processing_thinking_effort: postProcessing.thinking_effort,
    ...(postProcessing.model !== baseModel.model ||
    postProcessing.model_provider !== baseModel.model_provider ||
    postProcessing.harness !== baseModel.harness
      ? {
          post_processing_model: postProcessing.model,
          post_processing_model_provider: postProcessing.model_provider,
          post_processing_harness: postProcessing.harness,
        }
      : {}),
    model_overrides: modelOverrides,
    severity_ranker: severityRanker,
    extra,
    jobLimit,
  };

  const summaryLines = [
    { text: '✓ Configuration is complete', tone: 'success' },
    `Workflow: ${workflow.name}`,
    `Post-scripts: ${selectedPostScripts.map((item) => item.name).join(', ')}`,
    `Target: ${repoKind}:${repoFull}${commitSha ? `@${commitSha}` : ''}`,
    `Model: ${baseModel.model_provider}/${baseModel.model} via ${baseModel.harness}`,
    `Skills: ${selectedSkills.length}`,
    `Rankers: ${selectedRankers.length}${customRanker ? ' + custom rules' : ''}`,
  ];
  if (
    !setNextContext(prompter, {
      title: 'Review and launch',
      subtitle: 'Create scan · final step',
      details: summaryLines,
      confirmLabel: 'Create scan',
      confirmDescription: 'Submit this configuration to the engine',
      cancelLabel: 'Cancel',
      cancelDescription: 'Return without creating a scan',
    })
  ) {
    write(io);
    write(io, 'Scan summary');
    summaryLines.slice(1).forEach((line) => write(io, `  ${line}`));
  }
  if (!(await prompter.confirm('Create this scan?', { defaultValue: true }))) return null;

  try {
    showLoading(prompter, io, 'Submitting the scan to the engine…');
    return await client.createScan(payload);
  } catch (error) {
    if (!(error instanceof HeadlessApiError) || error.code !== 'scan_launch_policy_required') throw error;
    const launchPolicy = await prompter.select('Another scan is active. Launch policy', ['queue', 'immediate'], {
      label: (value) => (value === 'queue' ? 'Queue until the active pool is clear' : 'Start immediately'),
    });
    return client.createScan({ ...payload, launchPolicy });
  }
}

export async function importPortableResource({ client, resourceType, filePath, rootDir = process.cwd() }) {
  const config = RESOURCE_IMPORTS[resourceType];
  if (!config) throw new Error(`Unsupported import type: ${resourceType}`);
  if (!filePath) throw new Error(`Provide a path to a ${config.label} JSON file.`);
  const resolvedPath = isAbsolute(filePath) ? filePath : resolve(rootDir, filePath);
  const file = await stat(resolvedPath);
  if (!file.isFile()) throw new Error(`Import path is not a file: ${resolvedPath}`);
  if (file.size > config.maxBytes) throw new Error(`${config.label} JSON files must be 2 MB or smaller.`);
  const payload = config.parse(await readFile(resolvedPath, 'utf8'));
  return client.importResource(config.endpoint, payload);
}

function valueText(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return `${value}`;
}

export function formatScanSummary(scan, { detailed = false } = {}) {
  const lines = [
    `Scan ${scan.id} · ${scan.status}`,
    `  Target: ${scan.repoDisplay || scan.repoFull || '—'}${scan.commitShort ? ` @ ${scan.commitShort}` : ''}`,
    `  Workflow: ${scan.workflowName || scan.workflowId || '—'}`,
    `  Post-scripts: ${(scan.postScriptNames || [scan.postScriptName]).filter(Boolean).join(', ') || '—'}`,
  ];
  const summary = scan.statusSummary || {};
  if (scan.progress || summary.progress) {
    lines.push(
      `  Progress: ${scan.progress || summary.progress} · ${scan.progressLabel || summary.progressLabel || ''}`.trimEnd()
    );
  }
  if (scan.reasoning?.code || scan.reasoning?.message || scan.reasoning?.error) {
    lines.push(
      `  Reason: ${[scan.reasoning.code, scan.reasoning.message || scan.reasoning.error].filter(Boolean).join(' · ')}`
    );
  }
  if (detailed) {
    lines.push(`  Model: ${scan.modelProvider || '—'}/${scan.model || '—'} via ${scan.harness || '—'}`);
    lines.push(`  Attempts: ${summary.completedAttempts || 0}/${summary.totalAttempts || 0} completed`);
    const activeJobs = Array.isArray(summary.activeJobs) ? summary.activeJobs : [];
    if (activeJobs.length) {
      lines.push(`  Active workers (${activeJobs.length}):`);
      for (const job of activeJobs) {
        const stage = job.depth === null || job.depth === undefined ? job.source : `depth ${job.depth}`;
        lines.push(
          `    - ${stage} · ${job.title || job.source} · ${job.phaseLabel || job.phase || job.status}` +
            `${job.model ? ` · ${job.modelProvider || 'provider'}/${job.model}` : ''}`
        );
      }
    }
    const errors = Array.isArray(summary.recentErrors) ? summary.recentErrors : [];
    if (errors.length) {
      lines.push('  Recent errors:');
      for (const error of errors) {
        lines.push(
          `    - ${error.previousRun ? '[previous run] ' : ''}${error.source || 'Scan'} / ${error.phaseLabel || error.phase || 'failed'}: ${error.message}`
        );
      }
    }
    lines.push(`  Created: ${valueText(scan.insertedAt)}`);
    lines.push(`  Updated: ${valueText(scan.updatedAt)}`);
  }
  return lines.join('\n');
}

export function formatSettings(payload) {
  const lines = ['Engine runtime settings'];
  for (const [key, setting] of Object.entries(payload?.settings || {})) {
    const range = setting.type === 'boolean' ? '' : `; range ${valueText(setting.min)}–${valueText(setting.max)}`;
    lines.push(`  ${key} = ${valueText(setting.value)} (${setting.envKey}; ${setting.apply}${range})`);
  }
  return lines.join('\n');
}

function normalizedSettingValue(setting, value) {
  if (setting.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (/^(?:1|true|yes|on)$/i.test(value)) return true;
    if (/^(?:0|false|no|off)$/i.test(value)) return false;
    throw new Error('Enter true or false.');
  }
  const number = Number(value);
  if (!`${value}`.trim() || !Number.isFinite(number)) throw new Error('Enter a number.');
  if (setting.type !== 'number' && !Number.isSafeInteger(number)) throw new Error('Enter a whole number.');
  if (number < setting.min || number > setting.max)
    throw new Error(`Enter a value from ${setting.min} to ${setting.max}.`);
  return number;
}

export async function setRuntimeSetting({ client, key, value }) {
  const current = await client.settings();
  const setting = current?.settings?.[key];
  if (!setting) throw new Error(`Unknown runtime setting: ${key}`);
  return client.updateSettings({ [key]: normalizedSettingValue(setting, value) });
}

function runtimeSettingWarning(key, value, setting) {
  if (key === 'workerCount' && value === 0) {
    return 'This pauses pickup of new engine work. Jobs already running are allowed to finish.';
  }
  if (key === 'workerCount' && Number.isFinite(setting.recommendedMax) && value > setting.recommendedMax) {
    return `This is above the conservative recommendation of ${setting.recommendedMax} and can exhaust provider or host capacity.`;
  }
  if (key === 'ignoreLowStorage' && value === true) {
    return 'This allows new scan containers to start even when they may fill the host disk.';
  }
  return null;
}

async function configureSettingsInteractively({ client, prompter, io }) {
  setSection(prompter, 'Runtime settings', 'Changes apply to the running engine');
  showLoading(prompter, io, 'Loading engine settings…');
  let current = await client.settings();
  while (true) {
    const settingLines = formatSettings(current).split('\n');
    const hasContext = setNextContext(prompter, {
      title: 'Runtime settings',
      subtitle: 'Select a setting to inspect or change',
      details: [{ text: '● Engine settings are live', tone: 'success' }, ...settingLines.slice(1)],
    });
    if (!hasContext) write(io, formatSettings(current));
    const keys = Object.keys(current.settings || {});
    const selected = await prompter.select('Setting to change', [...keys, 'Back'], {
      label: (key) => (key === 'Back' ? key : `${key} (current: ${valueText(current.settings[key].value)})`),
      defaultIndex: keys.length,
    });
    if (selected === 'Back') return;
    const setting = current.settings[selected];
    const value = await prompter.ask(`New ${selected}`, { defaultValue: valueText(setting.value), required: true });
    const normalized = normalizedSettingValue(setting, value);
    const warning = runtimeSettingWarning(selected, normalized, setting);
    if (warning) {
      if (
        !setNextContext(prompter, {
          title: 'Review risky setting',
          subtitle: `${selected} = ${normalized}`,
          details: [{ text: `! ${warning}`, tone: 'warning' }],
          confirmLabel: 'Apply anyway',
          cancelLabel: 'Keep current value',
        })
      ) {
        write(io, `Warning: ${warning}`);
      }
      if (!(await prompter.confirm('Continue with this risky setting?', { defaultValue: false }))) continue;
    }
    if (!warning) {
      setNextContext(prompter, {
        title: `Save ${selected}?`,
        subtitle: 'Runtime settings',
        details: [`Current: ${valueText(setting.value)}`, `New: ${normalized}`, `Applies: ${setting.apply}`],
        confirmLabel: 'Save setting',
        cancelLabel: 'Cancel',
      });
      if (!(await prompter.confirm(`Save ${selected} = ${normalized}?`, { defaultValue: true }))) continue;
    }
    current = await client.updateSettings({ [selected]: normalized });
    await presentNotice(prompter, io, {
      title: 'Setting saved',
      subtitle: 'Runtime settings',
      message: `${selected} is now ${normalized}.`,
    });
  }
}

function apiErrorLines(error) {
  if (!(error instanceof HeadlessApiError) || !error.errors.length) return [error.message];
  return [error.message, ...error.errors.map((item) => `  ${item.field}: ${item.message}`)];
}

async function showScansInteractively({ client, prompter, io, rootDir }) {
  setSection(prompter, 'Scans', 'Live engine activity and scan history');
  showLoading(prompter, io, 'Loading scans…');
  const scans = scanListItems(await client.scans('all'));
  if (!scans.length) {
    await presentNotice(prompter, io, {
      title: 'No scans yet',
      subtitle: 'Scan history is empty',
      message: 'Create a scan from the command center to start a security review.',
    });
    return;
  }
  const scan = await prompter.select('Inspect a scan', scans, {
    label: (item) => `#${item.id} · ${item.status.replaceAll('_', ' ')}`,
  });
  showLoading(prompter, io, `Loading scan #${scan.id}…`);
  const detailed = await client.scan(scan.id);
  await presentDocument(prompter, io, {
    title: `Scan #${detailed.id}`,
    subtitle: `${detailed.repoDisplay || detailed.repoFull || 'Unknown target'} · ${detailed.status.replaceAll('_', ' ')}`,
    lines: scanDocumentLines(detailed, { detailed: true }),
    footer: '↑↓ scroll   Enter or Esc for actions   Ctrl+C exit',
  });
  const actions = ['Back', 'Export findings'];
  if (['prewarming_cache', 'running', 'post_processing'].includes(detailed.status)) actions.push('Pause');
  if (
    ['queued', 'pending', 'prewarming_cache', 'running', 'rate_limited', 'paused', 'post_processing'].includes(
      detailed.status
    )
  ) {
    actions.push('Stop');
  }
  if (['failed', 'paused', 'stopped'].includes(detailed.status)) actions.push('Resume');
  const action = await prompter.select('Scan action', actions);
  if (action === 'Back') return;
  if (action === 'Export findings') {
    const destination = await prompter.ask('Destination directory or .zip path', { defaultValue: rootDir });
    showLoading(prompter, io, 'Building and downloading the findings archive…');
    const outputPath = await client.downloadScanExport(scan.id, destination);
    await presentNotice(prompter, io, {
      title: 'Export saved',
      subtitle: `Scan #${scan.id}`,
      message: outputPath,
    });
    return;
  }
  const status = SCAN_ACTIONS[action.toLowerCase()];
  if (!status) return;
  showLoading(prompter, io, `${action} request in progress…`);
  const updated = await client.updateScan(scan.id, { status });
  await presentDocument(prompter, io, {
    title: `Scan #${updated.id} updated`,
    subtitle: updated.status.replaceAll('_', ' '),
    lines: scanDocumentLines(updated, { detailed: true }),
  });
}

async function interactiveImport({ client, prompter, io, rootDir }) {
  setSection(prompter, 'Import resource', 'Bring portable configuration into this instance');
  const resourceType = await prompter.select('Portable resource type', Object.keys(RESOURCE_IMPORTS), {
    label: (value) => RESOURCE_IMPORTS[value].label,
  });
  const filePath = await prompter.ask(`Path to ${RESOURCE_IMPORTS[resourceType].label} JSON`, { required: true });
  showLoading(prompter, io, `Validating and importing ${RESOURCE_IMPORTS[resourceType].label}…`);
  const imported = await importPortableResource({ client, resourceType, filePath, rootDir });
  await presentNotice(prompter, io, {
    title: 'Import complete',
    subtitle: RESOURCE_IMPORTS[resourceType].label,
    message: `Imported "${imported.name}" (id ${imported.id}).`,
  });
}

export async function runHeadlessInteractive({ client, prompter, io = defaultIo(), rootDir = process.cwd() }) {
  prompter.setBaseUrl?.(client.baseUrl);
  setSection(prompter, 'Command center');
  showLoading(prompter, io, `Connecting to ${client.baseUrl}…`);
  let health = await client.health();
  while (true) {
    setSection(prompter, 'Command center');
    setNextContext(prompter, {
      details: [
        { text: `● ${health.service || 'open-kritt'} is ${health.status || 'online'}`, tone: 'success' },
        { text: client.baseUrl, tone: 'dim' },
      ],
    });
    const action = await prompter.select('Main menu', [
      'Create scan',
      'Inspect scans',
      'Import portable resource',
      'Configure settings',
      'Check service health',
      'Exit',
    ]);
    if (action === 'Exit') return 0;
    try {
      if (action === 'Create scan') {
        const scan = await createScanInteractively({ client, prompter, io, rootDir });
        await presentNotice(prompter, io, {
          title: scan ? `Scan #${scan.id} created` : 'Scan creation cancelled',
          subtitle: scan ? scan.status.replaceAll('_', ' ') : 'Nothing was submitted',
          message: scan
            ? `Scan #${scan.id} is ${scan.status.replaceAll('_', ' ')}. Inspect scans to follow its progress.`
            : 'Your configuration was not submitted.',
        });
      } else if (action === 'Inspect scans') {
        await showScansInteractively({ client, prompter, io, rootDir });
      } else if (action === 'Import portable resource') {
        await interactiveImport({ client, prompter, io, rootDir });
      } else if (action === 'Configure settings') {
        await configureSettingsInteractively({ client, prompter, io });
      } else if (action === 'Check service health') {
        setSection(prompter, 'Service health');
        showLoading(prompter, io, 'Checking the backend…');
        health = await client.health();
        await presentNotice(prompter, io, {
          title: 'Service is healthy',
          subtitle: client.baseUrl,
          message: `${health.service}: ${health.status}`,
        });
      }
    } catch (error) {
      if (error instanceof HeadlessFlowCancelledError) continue;
      if (error instanceof TerminalCancelledError) throw error;
      if (prompter.notice) {
        await prompter.notice({
          title: 'That did not work',
          subtitle: 'Review the details and try again',
          message: apiErrorLines(error).join('\n'),
        });
      } else {
        apiErrorLines(error).forEach((line) => writeError(io, line));
      }
    }
  }
}

const HELP = `open-kritt headless CLI

Usage:
  ./kritt-headless
  ./kritt-headless health
  ./kritt-headless import <workflow|post-script|skill|ranker> [path]
  ./kritt-headless scan create
  ./kritt-headless scan list [all|running|queued|pending|prewarming_cache|rate_limited|paused|post_processing|completed|stopped|failed]
  ./kritt-headless scan show <id>
  ./kritt-headless scan <pause|resume|stop> <id>
  ./kritt-headless scan export <id> [destination] [--force]
  ./kritt-headless settings show
  ./kritt-headless settings set <key> <value>

The backend must already be running (normally via ./kritt start). The API defaults
to http://127.0.0.1:<BACKEND_PORT>/api. Set OPEN_KRITT_API_URL or pass
--api-url <url> to use another backend. Scan exports default to the repository root.`;

function takeGlobalOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return { argv, value: null };
  if (!argv[index + 1]) throw new Error(`${name} requires a value.`);
  return { value: argv[index + 1], argv: [...argv.slice(0, index), ...argv.slice(index + 2)] };
}

function scanListItems(payload) {
  return Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : [];
}

function defaultInteractivePrompter({ io, client }) {
  if (isInteractiveTerminal(io)) {
    return new FullscreenHeadlessPrompter({ io, baseUrl: client.baseUrl });
  }
  return new HeadlessPrompter({ io });
}

export async function runHeadlessCli(argv, options = {}) {
  const io = options.io || defaultIo();
  const rootDir = options.rootDir || process.cwd();
  let parsed;
  try {
    parsed = takeGlobalOption(argv, '--api-url');
    const baseUrl = await resolveHeadlessApiBase({ rootDir, env: options.env, apiUrl: parsed.value });
    const client = options.client || new HeadlessApiClient({ baseUrl, fetchImpl: options.fetchImpl });
    const args = parsed.argv;
    if (!args.length) {
      if (!io.input?.isTTY || !io.output?.isTTY) {
        writeError(io, 'Interactive mode requires a terminal. Run ./kritt-headless help for command usage.');
        return 1;
      }
      const prompter = options.prompter || defaultInteractivePrompter({ io, client });
      try {
        await prompter.enter?.();
        return await runHeadlessInteractive({ client, prompter, io, rootDir });
      } finally {
        await prompter.close?.();
      }
    }

    const [command, subcommand, ...rest] = args;
    if (['help', '--help', '-h'].includes(command)) {
      write(io, HELP);
      return 0;
    }
    if (command === 'health') {
      const health = await client.health();
      write(io, `${health.service}: ${health.status}`);
      return 0;
    }
    if (command === 'import') {
      const config = RESOURCE_IMPORTS[subcommand];
      if (!config) throw new Error('Import type must be workflow, post-script, skill, or ranker.');
      let filePath = rest[0];
      let prompter = options.prompter;
      if (!filePath) {
        if (!io.input?.isTTY) throw new Error(`Provide a path to a ${config.label} JSON file.`);
        prompter ||= defaultInteractivePrompter({ io, client });
        try {
          await prompter.enter?.();
          filePath = await prompter.ask(`Path to ${config.label} JSON`, { required: true });
        } finally {
          if (!options.prompter) await prompter.close?.();
        }
      }
      const imported = await importPortableResource({ client, resourceType: subcommand, filePath, rootDir });
      write(io, `Imported ${config.label} "${imported.name}" (id ${imported.id}).`);
      return 0;
    }
    if (command === 'scan' && subcommand === 'create') {
      if (!io.input?.isTTY && !options.prompter) throw new Error('Scan creation requires an interactive terminal.');
      const prompter = options.prompter || defaultInteractivePrompter({ io, client });
      try {
        await prompter.enter?.();
        const scan = await createScanInteractively({ client, prompter, io, rootDir });
        if (prompter.notice) {
          await presentNotice(prompter, io, {
            title: scan ? `Scan #${scan.id} created` : 'Scan creation cancelled',
            subtitle: scan ? scan.status.replaceAll('_', ' ') : 'Nothing was submitted',
            message: scan
              ? `The scan is ${scan.status.replaceAll('_', ' ')}.`
              : 'Your configuration was not submitted.',
          });
        } else {
          write(io, scan ? `Created scan ${scan.id} with status ${scan.status}.` : 'Scan creation cancelled.');
        }
      } finally {
        if (!options.prompter) await prompter.close?.();
      }
      return 0;
    }
    if (command === 'scan' && subcommand === 'list') {
      const status = rest[0] || 'all';
      if (!SCAN_LIST_STATUSES.has(status)) {
        throw new Error(`Unknown scan status: ${status}`);
      }
      const scans = scanListItems(await client.scans(status));
      if (!scans.length) write(io, 'No scans found.');
      else scans.forEach((scan) => write(io, formatScanSummary(scan)));
      return 0;
    }
    if (command === 'scan' && subcommand === 'show') {
      if (!/^\d+$/.test(rest[0] || '')) throw new Error('Provide a numeric scan id.');
      write(io, formatScanSummary(await client.scan(rest[0]), { detailed: true }));
      return 0;
    }
    if (command === 'scan' && Object.hasOwn(SCAN_ACTIONS, subcommand)) {
      if (!/^\d+$/.test(rest[0] || '')) throw new Error('Provide a numeric scan id.');
      const updated = await client.updateScan(rest[0], { status: SCAN_ACTIONS[subcommand] });
      write(io, formatScanSummary(updated, { detailed: true }));
      return 0;
    }
    if (command === 'scan' && subcommand === 'export') {
      if (!/^\d+$/.test(rest[0] || '')) throw new Error('Provide a numeric scan id.');
      const force = rest.includes('--force');
      const destination = rest.find((value, index) => index > 0 && value !== '--force') || rootDir;
      const outputPath = await client.downloadScanExport(rest[0], destination, { overwrite: force });
      write(io, `Export saved to ${outputPath}`);
      return 0;
    }
    if (command === 'settings' && (!subcommand || subcommand === 'show')) {
      write(io, formatSettings(await client.settings()));
      return 0;
    }
    if (command === 'settings' && subcommand === 'set') {
      if (!rest[0] || rest[1] === undefined) throw new Error('Usage: ./kritt-headless settings set <key> <value>');
      write(io, formatSettings(await setRuntimeSetting({ client, key: rest[0], value: rest[1] })));
      return 0;
    }
    throw new Error(`Unknown command.\n\n${HELP}`);
  } catch (error) {
    if (error instanceof TerminalCancelledError || error instanceof HeadlessFlowCancelledError) return 130;
    apiErrorLines(error).forEach((line) => writeError(io, line));
    return 1;
  }
}
