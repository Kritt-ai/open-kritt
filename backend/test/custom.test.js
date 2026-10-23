import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { getAccountProvider } from '../src/lib/accounts.js';
import { modelCatalogEntry } from '../src/lib/modelCatalog.js';
import { configuredModelProviders } from '../src/lib/modelProviders.js';
import {
  providerCredentialStatuses,
  removeManagedProviderCredential,
  saveManagedProviderCredential,
  validateProviderCredential,
} from '../src/lib/providerCredentials.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'provider-custom-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { credentialsPath: join(directory, 'providers.json'), environmentFilePath: join(directory, '.env') };
}

test('custom keys reuse protected storage but need an endpoint base URL to scan', async (t) => {
  const options = await fixture(t);
  const env = { CUSTOM_LLM_BASE_URL: 'https://llm.example.com/v1' };
  await saveManagedProviderCredential('custom', 'fake-custom-key', options);

  // A key alone is stored but does not make the provider usable for scans.
  assert.equal(configuredModelProviders({ ...options, env: {} }).includes('custom'), false);

  const statuses = providerCredentialStatuses({ ...options, env });
  const provider = statuses.find((item) => item.id === 'custom');
  assert.equal(provider.management, 'api_key');
  assert.equal(provider.credentialLabel, 'Custom API key');
  assert.equal(JSON.stringify(statuses).includes('fake-custom-key'), false);
  assert.equal((await stat(options.credentialsPath)).mode & 0o777, 0o600);
  assert.equal((await stat(options.environmentFilePath)).mode & 0o777, 0o600);
  assert.match(await readFile(options.environmentFilePath, 'utf8'), /CUSTOM_LLM_API_KEY=fake-custom-key/);
  assert.equal(configuredModelProviders({ ...options, env }).includes('custom'), true);

  const overview = await getAccountProvider('custom', { statusOptions: { ...options, env } });
  assert.equal(overview.loadError, null);
  assert.equal(overview.accounts[0].path, 'CUSTOM_LLM_API_KEY');
  assert.equal(overview.accounts[0].active, true);

  assert.equal(modelCatalogEntry('custom', null).input, 'text');

  assert.equal(validateProviderCredential('custom', '   ')?.field, 'credential');
  await removeManagedProviderCredential('custom', { ...options, disableEnvironment: true });
  assert.equal(configuredModelProviders({ ...options, env }).includes('custom'), false);
});
