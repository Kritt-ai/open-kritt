import { getAccountsSummary } from './accounts.js';
import {
  customProviderStatuses,
  PROVIDER_CREDENTIALS_PATH,
  providerCredentialStatuses,
} from './providerCredentials.js';
import { configuredModelProviderIdsFromSources } from './modelProviders.js';

export async function discoverConfiguredModelProviders({
  statusOptions,
  credentialsPath = PROVIDER_CREDENTIALS_PATH,
  refresh = false,
  getSummary = getAccountsSummary,
} = {}) {
  const [credentialStatuses, accountSummary] = await Promise.all([
    Promise.resolve(providerCredentialStatuses({ ...statusOptions, credentialsPath })),
    Promise.resolve()
      .then(() => getSummary({ refresh, statusOptions }))
      .catch(() => null),
  ]);

  return configuredModelProviderIdsFromSources({
    credentialStatuses,
    accountProviders: accountSummary?.providers || [],
    customProviders: customProviderStatuses({ credentialsPath }),
  });
}
