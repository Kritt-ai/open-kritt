import { MODEL_PROVIDERS } from './constants.js';
import {
  PROVIDER_CREDENTIALS_PATH,
  customProviderDefinition,
  customProviderStatuses,
  readManagedCredentialStateSync,
} from './providerCredentials.js';
import { providerLoginIsConfigured } from './providerLogins.js';

const PROVIDER_CREDENTIALS = {
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

export function configuredModelProviders({
  env = process.env,
  credentialsPath = PROVIDER_CREDENTIALS_PATH,
  loginOptions,
} = {}) {
  const store = readManagedCredentialStateSync(credentialsPath);
  const managed = store.credentials;
  const disabledEnvironmentProviders = new Set(store.disabledEnvironmentProviders);
  const builtins = MODEL_PROVIDERS.filter((provider) => {
    if (hasValue(managed[provider])) return true;
    if (providerLoginIsConfigured(provider, { env, ...loginOptions })) return true;
    if (disabledEnvironmentProviders.has(provider)) return false;
    return PROVIDER_CREDENTIALS[provider].some((key) => credentialIsConfigured(env, key));
  });
  return [...builtins, ...customProviderStatuses({ credentialsPath }).map((provider) => provider.id)];
}

export function modelProviderHarnesses(provider, { credentialsPath = PROVIDER_CREDENTIALS_PATH } = {}) {
  const builtin = BUILTIN_PROVIDER_HARNESSES[provider];
  if (builtin) return [...builtin];
  return customProviderDefinition(provider, credentialsPath)?.harnesses || [];
}

export function isModelProviderConfigured(provider, options) {
  return configuredModelProviders(options).includes(provider);
}
