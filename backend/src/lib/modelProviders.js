import {
  BUILTIN_PROVIDER_DEFINITIONS,
  PROVIDER_CREDENTIALS_PATH,
  customProviderDefinition,
  customProviderStatuses,
  readManagedCredentialStateSync,
} from './providerCredentials.js';
import { providerLoginIsConfigured } from './providerLogins.js';

const BUILTIN_PROVIDER_CREDENTIALS = {
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
  claude: ['ANTHROPIC_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
};

const BUILTIN_PROVIDER_HARNESSES = {
  codex: ['codex'],
  claude: ['claude-code'],
  openrouter: ['codex', 'claude-code'],
};

function hasValue(value) {
  return typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
}

function hasConfiguredFlag(value) {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}

function credentialIsConfigured(env, key) {
  return hasConfiguredFlag(env[`OPEN_KRITT_${key}_CONFIGURED`]) || hasValue(env[key]);
}

function codexRuntimeEnabled({ env = process.env, loginOptions } = {}) {
  const explicit = String(env.OPEN_KRITT_ENABLE_CODEX || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(explicit)) return true;
  if (['0', 'false', 'no', 'off'].includes(explicit)) return false;
  if (credentialIsConfigured(env, 'CODEX_API_KEY')) return true;
  if (credentialIsConfigured(env, 'OPENAI_API_KEY')) return true;
  return providerLoginIsConfigured('codex', { env, ...loginOptions });
}

export function configuredModelProviderIdsFromSources({
  credentialStatuses = [],
  accountProviders = [],
  customProviders = [],
} = {}) {
  const ids = new Set();
  for (const status of Array.isArray(credentialStatuses) ? credentialStatuses : []) {
    if (status?.configured) ids.add(status.id);
  }
  for (const provider of Array.isArray(accountProviders) ? accountProviders : []) {
    if (provider?.configured) ids.add(provider.id);
  }
  for (const provider of Array.isArray(customProviders) ? customProviders : []) {
    if (provider?.id) ids.add(provider.id);
  }
  return [...ids];
}

export function configuredModelProviders({
  env = process.env,
  credentialsPath = PROVIDER_CREDENTIALS_PATH,
  loginOptions,
  accountProviders = [],
} = {}) {
  const store = readManagedCredentialStateSync(credentialsPath);
  const managed = store.credentials;
  const disabledEnvironmentProviders = new Set(store.disabledEnvironmentProviders);
  const builtins = Object.keys(BUILTIN_PROVIDER_DEFINITIONS).filter((provider) => {
    if (provider === 'codex' && !codexRuntimeEnabled({ env, loginOptions })) return false;
    if (hasValue(managed[provider])) return true;
    if (providerLoginIsConfigured(provider, { env, ...loginOptions })) return true;
    if (disabledEnvironmentProviders.has(provider)) return false;
    return BUILTIN_PROVIDER_CREDENTIALS[provider].some((key) => credentialIsConfigured(env, key));
  });
  const customProviders = customProviderStatuses({ credentialsPath });
  return configuredModelProviderIdsFromSources({
    credentialStatuses: builtins.map((provider) => ({ id: provider, configured: true })),
    accountProviders,
    customProviders,
  });
}

export function modelProviderHarnesses(provider, { credentialsPath = PROVIDER_CREDENTIALS_PATH } = {}) {
  const builtin = BUILTIN_PROVIDER_HARNESSES[provider];
  if (builtin) return [...builtin];
  return customProviderDefinition(provider, credentialsPath)?.harnesses || [];
}

export function isModelProviderConfigured(provider, options) {
  return configuredModelProviders(options).includes(provider);
}
