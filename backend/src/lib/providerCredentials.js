import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { PROJECT_ENV_FILE_PATH, updateEnvironmentFile } from './environmentFile.js';
import { providerLoginIsConfigured } from './providerLogins.js';

export const PROVIDER_CREDENTIALS_PATH =
  process.env.OPEN_KRITT_PROVIDER_CREDENTIALS_PATH || '/credentials/providers.json';

export const PROVIDER_DEFINITIONS = {
  codex: {
    label: 'Codex',
    envKeys: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
    credentialLabel: 'Codex login',
    description: 'ChatGPT subscription account authenticated through Codex device login.',
    management: 'login',
  },
  claude: {
    label: 'Claude',
    envKeys: ['ANTHROPIC_API_KEY'],
    credentialLabel: 'Claude login',
    description: 'Claude subscription accounts authenticated through Claude Code.',
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

const MANAGED_CREDENTIAL_PROVIDERS = new Set(['openrouter']);

const MAX_CREDENTIAL_LENGTH = 16 * 1024;
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
  return { version: 1, credentials: {}, disabledEnvironmentProviders: [] };
}

function normalizeStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyStore();
  const source = value.credentials;
  const credentials = {};
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const provider of MANAGED_CREDENTIAL_PROVIDERS) {
      if (hasValue(source[provider])) credentials[provider] = String(source[provider]);
    }
  }
  const disabledEnvironmentProviders = Array.isArray(value.disabledEnvironmentProviders)
    ? [...new Set(value.disabledEnvironmentProviders.filter((provider) => MANAGED_CREDENTIAL_PROVIDERS.has(provider)))]
    : [];
  return { version: 1, credentials, disabledEnvironmentProviders };
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

async function readStore(credentialsPath) {
  try {
    return normalizeStore(JSON.parse(await readFile(credentialsPath, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore();
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

export function validateProviderCredential(provider, credential) {
  if (!MANAGED_CREDENTIAL_PROVIDERS.has(provider)) {
    return { field: 'provider', message: 'Only OpenRouter uses an API key in Accounts.' };
  }
  if (typeof credential !== 'string' || !credential.trim()) {
    return { field: 'credential', message: 'Enter an API key.' };
  }
  if (credential.length > MAX_CREDENTIAL_LENGTH || /[\r\n]/.test(credential)) {
    return { field: 'credential', message: 'The API key must be a single line under 16 KB.' };
  }
  return null;
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
      disabledEnvironmentProviders: [...store.disabledEnvironmentProviders],
    };
    store.credentials[provider] = credential.trim();
    store.disabledEnvironmentProviders = store.disabledEnvironmentProviders.filter(
      (candidate) => candidate !== provider
    );
    await writeStore(credentialsPath, store);
    try {
      await updateEnvironmentFile(
        { [PROVIDER_DEFINITIONS[provider].envKeys[0]]: credential.trim() },
        { environmentFilePath }
      );
    } catch (error) {
      await writeStore(credentialsPath, previousStore);
      throw error;
    }
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
      disabledEnvironmentProviders: [...store.disabledEnvironmentProviders],
    };
    const existed = Object.hasOwn(store.credentials, provider);
    delete store.credentials[provider];
    const wasDisabled = store.disabledEnvironmentProviders.includes(provider);
    if (disableEnvironment && !wasDisabled) store.disabledEnvironmentProviders.push(provider);
    await writeStore(credentialsPath, store);
    try {
      await updateEnvironmentFile({ [PROVIDER_DEFINITIONS[provider].envKeys[0]]: '' }, { environmentFilePath });
    } catch (error) {
      await writeStore(credentialsPath, previousStore);
      throw error;
    }
    return existed || (disableEnvironment && !wasDisabled);
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
  return Object.entries(PROVIDER_DEFINITIONS).map(([id, definition]) => {
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
