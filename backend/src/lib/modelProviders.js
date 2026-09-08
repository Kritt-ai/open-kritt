import { MODEL_PROVIDERS } from './constants.js';
import { PROVIDER_CREDENTIALS_PATH, readManagedCredentialStateSync } from './providerCredentials.js';
import { providerLoginIsConfigured } from './providerLogins.js';

const PROVIDER_CREDENTIALS = {
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
  claude: ['ANTHROPIC_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  xai: ['XAI_API_KEY'],
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
  return MODEL_PROVIDERS.filter((provider) => {
    if (hasValue(managed[provider])) return true;
    if (providerLoginIsConfigured(provider, { env, ...loginOptions })) return true;
    if (disabledEnvironmentProviders.has(provider)) return false;
    return PROVIDER_CREDENTIALS[provider].some((key) => credentialIsConfigured(env, key));
  });
}

export function isModelProviderConfigured(provider, options) {
  return configuredModelProviders(options).includes(provider);
}
