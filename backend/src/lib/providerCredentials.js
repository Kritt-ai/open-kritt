import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { PROJECT_ENV_FILE_PATH, updateEnvironmentFile } from './environmentFile.js';
import { providerLoginIsConfigured } from './providerLogins.js';

export const PROVIDER_CREDENTIALS_PATH =
  process.env.OPEN_KRITT_PROVIDER_CREDENTIALS_PATH || '/credentials/providers.json';

export const BUILTIN_PROVIDER_DEFINITIONS = {
  codex: {
    label: 'ChatGPT (Codex CLI)',
    envKeys: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
    credentialLabel: 'Codex CLI login',
    description: 'Local ChatGPT session authenticated through the Codex CLI executable.',
    management: 'login',
  },
  claude: {
    label: 'Claude Code CLI',
    envKeys: ['ANTHROPIC_API_KEY'],
    credentialLabel: 'Claude Code login',
    description: 'Local Claude session authenticated through the Claude Code CLI executable.',
    management: 'login',
  },
  openrouter: {
    label: 'OpenRouter',
    envKeys: ['OPENROUTER_API_KEY'],
    credentialLabel: 'OpenRouter API key',
    description: 'OpenRouter-compatible models through a project API key.',
    management: 'api_key',
  },
};

const BUILTIN_PROVIDER_IDS = Object.keys(BUILTIN_PROVIDER_DEFINITIONS);
const MANAGED_CREDENTIAL_PROVIDERS = new Set(['openrouter']);
const CUSTOM_PROVIDER_HARNESSES = ['openai-compatible'];
const CUSTOM_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const CUSTOM_PROVIDER_HEADER_NAME_RE = /^[A-Za-z0-9-]{1,100}$/;
const MAX_CREDENTIAL_LENGTH = 16 * 1024;
const MAX_PROVIDER_NAME_LENGTH = 80;
const MAX_PROVIDER_URL_LENGTH = 2_000;
const MAX_PROVIDER_MODEL_LENGTH = 200;
const MAX_PROVIDER_HEADER_VALUE_LENGTH = 4_000;
const MAX_CUSTOM_PROVIDERS = 200;
let writeQueue = Promise.resolve();

function hasValue(value) {
  return typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
}

function hasConfiguredFlag(value) {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}

function emptyStore() {
  return { version: 2, credentials: {}, customProviders: [], disabledEnvironmentProviders: [] };
}

function normalizedText(value, maxLength = MAX_CREDENTIAL_LENGTH) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength);
}

function normalizeExtraHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = [];
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = normalizedText(rawName, 100);
    const headerValue = normalizedText(`${rawValue ?? ''}`, MAX_PROVIDER_HEADER_VALUE_LENGTH);
    if (!name || !headerValue || !CUSTOM_PROVIDER_HEADER_NAME_RE.test(name)) continue;
    entries.push([name, headerValue]);
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

function customProviderIdFromName(name, existingIds = new Set()) {
  const base = normalizedText(name, MAX_PROVIDER_NAME_LENGTH)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const seed = base || 'custom-provider';
  let candidate = seed;
  let suffix = 2;
  while (existingIds.has(candidate)) {
    const extra = `-${suffix}`;
    candidate = `${seed.slice(0, Math.max(1, 63 - extra.length))}${extra}`;
    suffix += 1;
  }
  return candidate;
}

function normalizeCustomProviderRecord(value, index = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const label = normalizedText(value.label ?? value.name, MAX_PROVIDER_NAME_LENGTH);
  const id = normalizedText(value.id, 63).toLowerCase();
  const baseUrl = normalizedText(value.baseUrl ?? value.base_url, MAX_PROVIDER_URL_LENGTH);
  const apiKey = normalizedText(value.apiKey ?? value.api_key);
  const model = normalizedText(value.model, MAX_PROVIDER_MODEL_LENGTH);
  const organization = normalizedText(value.organization, MAX_PROVIDER_NAME_LENGTH);
  const extraHeaders = normalizeExtraHeaders(value.extraHeaders ?? value.extra_headers);
  const customId = CUSTOM_PROVIDER_ID_RE.test(id) ? id : label ? customProviderIdFromName(`${label}-${index}`) : '';
  if (!customId || !label || !baseUrl || !apiKey || !model) return null;
  return {
    id: customId,
    label,
    baseUrl,
    apiKey,
    model,
    ...(organization ? { organization } : {}),
    ...(Object.keys(extraHeaders).length ? { extraHeaders } : {}),
  };
}

function normalizeStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyStore();
  const source = value.credentials;
  const credentials = {};
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const provider of MANAGED_CREDENTIAL_PROVIDERS) {
      if (hasValue(source[provider])) credentials[provider] = String(source[provider]).trim();
    }
  }
  const seenCustomProviders = new Set();
  const customProviders = [];
  const customSource = Array.isArray(value.customProviders) ? value.customProviders : [];
  for (const [index, rawProvider] of customSource.entries()) {
    const provider = normalizeCustomProviderRecord(rawProvider, index + 1);
    if (!provider || seenCustomProviders.has(provider.id)) continue;
    seenCustomProviders.add(provider.id);
    customProviders.push(provider);
  }
  const disabledEnvironmentProviders = Array.isArray(value.disabledEnvironmentProviders)
    ? [...new Set(value.disabledEnvironmentProviders.filter((provider) => MANAGED_CREDENTIAL_PROVIDERS.has(provider)))]
    : [];
  return { version: 2, credentials, customProviders, disabledEnvironmentProviders };
}

function customProviderSummary(provider) {
  return {
    id: provider.id,
    label: provider.label,
    credentialLabel: 'API key',
    description: `OpenAI-compatible provider at ${provider.baseUrl}.`,
    management: 'api_key',
    configured: true,
    source: 'managed_api_key',
    canManage: true,
    canRemove: true,
    managed: true,
    kind: 'custom',
    harnesses: [...CUSTOM_PROVIDER_HARNESSES],
    defaultModel: provider.model,
    input: 'text',
    baseUrl: provider.baseUrl,
    model: provider.model,
    organization: provider.organization || '',
    extraHeaders: { ...(provider.extraHeaders || {}) },
  };
}

export function readManagedCredentialStateSync(credentialsPath = PROVIDER_CREDENTIALS_PATH) {
  try {
    return normalizeStore(JSON.parse(readFileSync(credentialsPath, 'utf8')));
  } catch {
    return emptyStore();
  }
}

export function readManagedCredentialsSync(credentialsPath = PROVIDER_CREDENTIALS_PATH) {
  return readManagedCredentialStateSync(credentialsPath).credentials;
}

export function readManagedCustomProvidersSync(credentialsPath = PROVIDER_CREDENTIALS_PATH) {
  return readManagedCredentialStateSync(credentialsPath).customProviders;
}

function knownProviderIds(credentialsPath = PROVIDER_CREDENTIALS_PATH) {
  const customProviders = readManagedCustomProvidersSync(credentialsPath);
  return [...BUILTIN_PROVIDER_IDS, ...customProviders.map((provider) => provider.id)];
}

export function builtinProviderIds() {
  return [...BUILTIN_PROVIDER_IDS];
}

export function customProviderDefinition(providerId, credentialsPath = PROVIDER_CREDENTIALS_PATH) {
  const provider = readManagedCustomProvidersSync(credentialsPath).find((entry) => entry.id === providerId);
  return provider ? customProviderSummary(provider) : null;
}

export function managedCustomProviderRecord(providerId, credentialsPath = PROVIDER_CREDENTIALS_PATH) {
  return readManagedCustomProvidersSync(credentialsPath).find((entry) => entry.id === providerId) || null;
}

export function knownModelProviderIdsSync(credentialsPath = PROVIDER_CREDENTIALS_PATH) {
  return knownProviderIds(credentialsPath);
}

async function readStore(credentialsPath) {
  try {
    return normalizeStore(JSON.parse(await readFile(credentialsPath, 'utf8')));
  } catch (error) {
    if (['ENOENT', 'EISDIR', 'EACCES', 'EPERM'].includes(error?.code)) return emptyStore();
    if (error instanceof SyntaxError) {
      throw new Error('The managed provider credential file is invalid JSON.', { cause: error });
    }
    throw error;
  }
}

async function writeStore(credentialsPath, store) {
  await mkdir(dirname(credentialsPath), { recursive: true, mode: 0o700 });
  const tempPath = join(dirname(credentialsPath), `.providers.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tempPath, credentialsPath);
  await chmod(credentialsPath, 0o600);
}

function queuedWrite(operation) {
  const pending = writeQueue.then(operation);
  writeQueue = pending.catch(() => {});
  return pending;
}

function validateSingleLine(field, value, label, maxLength = MAX_CREDENTIAL_LENGTH) {
  if (typeof value !== 'string' || !value.trim()) return { field, message: `${label} is required.` };
  if (value.length > maxLength || /[\r\n]/.test(value)) {
    return { field, message: `${label} must be a single line under ${maxLength} characters.` };
  }
  return null;
}

function validateBaseUrl(value) {
  const missing = validateSingleLine('baseUrl', value, 'Base URL', MAX_PROVIDER_URL_LENGTH);
  if (missing) return missing;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { field: 'baseUrl', message: 'Base URL must use http or https.' };
    }
  } catch {
    return { field: 'baseUrl', message: 'Base URL must be a valid URL.' };
  }
  return null;
}

function validateExtraHeaders(value) {
  if (value == null || value === '') return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { field: 'extraHeaders', message: 'Extra headers must be an object map.' };
  }
  for (const [name, headerValue] of Object.entries(value)) {
    if (!CUSTOM_PROVIDER_HEADER_NAME_RE.test(normalizedText(name, 100))) {
      return { field: 'extraHeaders', message: 'Header names may contain only letters, numbers, and hyphens.' };
    }
    const error = validateSingleLine('extraHeaders', `${headerValue ?? ''}`, 'Header values', MAX_PROVIDER_HEADER_VALUE_LENGTH);
    if (error) return { field: 'extraHeaders', message: error.message };
  }
  return null;
}

export function validateProviderCredential(provider, credential) {
  if (!MANAGED_CREDENTIAL_PROVIDERS.has(provider)) {
    return { field: 'provider', message: 'Only OpenRouter uses a single managed API key in Accounts.' };
  }
  if (typeof credential !== 'string' || !credential.trim()) {
    return { field: 'credential', message: 'Enter an API key.' };
  }
  if (credential.length > MAX_CREDENTIAL_LENGTH || /[\r\n]/.test(credential)) {
    return { field: 'credential', message: 'The API key must be a single line under 16 KB.' };
  }
  return null;
}

export function validateCustomProvider(payload, { existingIds = new Set(), providerId = null } = {}) {
  const name = normalizedText(payload?.label ?? payload?.name, MAX_PROVIDER_NAME_LENGTH);
  if (!name) return { field: 'name', message: 'Name is required.' };
  const apiKeyError = validateSingleLine('apiKey', payload?.apiKey, 'API key');
  if (apiKeyError) return apiKeyError;
  const modelError = validateSingleLine('model', payload?.model, 'Model', MAX_PROVIDER_MODEL_LENGTH);
  if (modelError) return modelError;
  const baseUrlError = validateBaseUrl(payload?.baseUrl);
  if (baseUrlError) return baseUrlError;
  const headerError = validateExtraHeaders(payload?.extraHeaders);
  if (headerError) return headerError;
  if (payload?.organization) {
    const orgError = validateSingleLine('organization', payload.organization, 'Organization', MAX_PROVIDER_NAME_LENGTH);
    if (orgError) return orgError;
  }
  const candidateId = providerId || customProviderIdFromName(name, existingIds);
  if (!CUSTOM_PROVIDER_ID_RE.test(candidateId)) {
    return { field: 'name', message: 'Name must produce a valid provider id.' };
  }
  const duplicate = existingIds.has(candidateId) && candidateId !== providerId;
  if (duplicate) return { field: 'name', message: 'A provider with this name already exists.' };
  return null;
}

function customProviderRecord(payload, { providerId, existingIds }) {
  return {
    id: providerId || customProviderIdFromName(payload.label ?? payload.name, existingIds),
    label: normalizedText(payload.label ?? payload.name, MAX_PROVIDER_NAME_LENGTH),
    baseUrl: normalizedText(payload.baseUrl, MAX_PROVIDER_URL_LENGTH),
    apiKey: normalizedText(payload.apiKey),
    model: normalizedText(payload.model, MAX_PROVIDER_MODEL_LENGTH),
    ...(hasValue(payload.organization)
      ? { organization: normalizedText(payload.organization, MAX_PROVIDER_NAME_LENGTH) }
      : {}),
    ...(Object.keys(normalizeExtraHeaders(payload.extraHeaders)).length
      ? { extraHeaders: normalizeExtraHeaders(payload.extraHeaders) }
      : {}),
  };
}

export async function saveManagedProviderCredential(
  provider,
  credential,
  { credentialsPath = PROVIDER_CREDENTIALS_PATH, environmentFilePath = PROJECT_ENV_FILE_PATH } = {}
) {
  const validationError = validateProviderCredential(provider, credential);
  if (validationError) {
    const error = new Error(validationError.message);
    error.validationError = validationError;
    throw error;
  }

  return queuedWrite(async () => {
    const store = await readStore(credentialsPath);
    const previousStore = {
      ...store,
      credentials: { ...store.credentials },
      customProviders: [...store.customProviders],
      disabledEnvironmentProviders: [...store.disabledEnvironmentProviders],
    };
    store.credentials[provider] = credential.trim();
    store.disabledEnvironmentProviders = store.disabledEnvironmentProviders.filter(
      (candidate) => candidate !== provider
    );
    await writeStore(credentialsPath, store);
    try {
      await updateEnvironmentFile(
        { [BUILTIN_PROVIDER_DEFINITIONS[provider].envKeys[0]]: credential.trim() },
        { environmentFilePath }
      );
    } catch (error) {
      await writeStore(credentialsPath, previousStore);
      throw error;
    }
  });
}

export async function saveCustomProvider(
  payload,
  { credentialsPath = PROVIDER_CREDENTIALS_PATH, providerId = null } = {}
) {
  return queuedWrite(async () => {
    const store = await readStore(credentialsPath);
    const existingIds = new Set(store.customProviders.map((provider) => provider.id));
    const existingProvider = providerId ? store.customProviders.find((provider) => provider.id === providerId) || null : null;
    const normalizedPayload =
      existingProvider && !hasValue(payload?.apiKey) ? { ...payload, apiKey: existingProvider.apiKey } : payload;
    const validationError = validateCustomProvider(normalizedPayload, { existingIds, providerId });
    if (validationError) {
      const error = new Error(validationError.message);
      error.validationError = validationError;
      throw error;
    }
    const record = customProviderRecord(normalizedPayload, { providerId, existingIds });
    const nextCustomProviders = store.customProviders.filter((provider) => provider.id !== record.id);
    if (!providerId && nextCustomProviders.length >= MAX_CUSTOM_PROVIDERS) {
      const error = new Error(`You can store up to ${MAX_CUSTOM_PROVIDERS} custom providers.`);
      error.validationError = { field: 'name', message: error.message };
      throw error;
    }
    nextCustomProviders.push(record);
    nextCustomProviders.sort((left, right) => left.label.localeCompare(right.label));
    store.customProviders = nextCustomProviders;
    await writeStore(credentialsPath, store);
    return customProviderSummary(record);
  });
}

export async function removeManagedProviderCredential(
  provider,
  {
    credentialsPath = PROVIDER_CREDENTIALS_PATH,
    disableEnvironment = false,
    environmentFilePath = PROJECT_ENV_FILE_PATH,
  } = {}
) {
  if (!MANAGED_CREDENTIAL_PROVIDERS.has(provider)) return false;
  return queuedWrite(async () => {
    const store = await readStore(credentialsPath);
    const previousStore = {
      ...store,
      credentials: { ...store.credentials },
      customProviders: [...store.customProviders],
      disabledEnvironmentProviders: [...store.disabledEnvironmentProviders],
    };
    const existed = Object.hasOwn(store.credentials, provider);
    delete store.credentials[provider];
    const wasDisabled = store.disabledEnvironmentProviders.includes(provider);
    if (disableEnvironment && !wasDisabled) store.disabledEnvironmentProviders.push(provider);
    await writeStore(credentialsPath, store);
    try {
      await updateEnvironmentFile({ [BUILTIN_PROVIDER_DEFINITIONS[provider].envKeys[0]]: '' }, { environmentFilePath });
    } catch (error) {
      await writeStore(credentialsPath, previousStore);
      throw error;
    }
    return existed || (disableEnvironment && !wasDisabled);
  });
}

export async function removeCustomProvider(providerId, { credentialsPath = PROVIDER_CREDENTIALS_PATH } = {}) {
  return queuedWrite(async () => {
    const store = await readStore(credentialsPath);
    const initialCount = store.customProviders.length;
    store.customProviders = store.customProviders.filter((provider) => provider.id !== providerId);
    if (store.customProviders.length === initialCount) return false;
    await writeStore(credentialsPath, store);
    return true;
  });
}

export function providerCredentialStatuses({
  env = process.env,
  credentialsPath = PROVIDER_CREDENTIALS_PATH,
  loginOptions,
} = {}) {
  const store = readManagedCredentialStateSync(credentialsPath);
  const managed = store.credentials;
  const disabledEnvironmentProviders = new Set(store.disabledEnvironmentProviders);
  return BUILTIN_PROVIDER_IDS.map((id) => {
    const definition = BUILTIN_PROVIDER_DEFINITIONS[id];
    const managedCredential = hasValue(managed[id]);
    const environmentCredential =
      !disabledEnvironmentProviders.has(id) &&
      definition.envKeys.some((key) => hasValue(env[key]) || hasConfiguredFlag(env[`OPEN_KRITT_${key}_CONFIGURED`]));
    const savedLogin = providerLoginIsConfigured(id, { env, ...loginOptions });
    const configured = managedCredential || environmentCredential || savedLogin;
    const source = managedCredential
      ? 'managed_api_key'
      : savedLogin
        ? `${id}_login`
        : environmentCredential
          ? 'environment'
          : null;
    return {
      id,
      label: definition.label,
      description: definition.description,
      credentialLabel: definition.credentialLabel,
      management: definition.management,
      configured,
      source,
      canManage: definition.management === 'login' || id === 'openrouter',
      canRemove: id === 'openrouter' && (managedCredential || environmentCredential),
      managed: managedCredential,
    };
  });
}

export function customProviderStatuses({ credentialsPath = PROVIDER_CREDENTIALS_PATH } = {}) {
  return readManagedCustomProvidersSync(credentialsPath).map(customProviderSummary);
}
