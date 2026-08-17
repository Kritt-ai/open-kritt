import { Router } from 'express';
import { setTimeout as delay } from 'node:timers/promises';

import { accountLoginManager } from '../lib/accountLogins.js';
import {
  consumeCodexManualReset,
  getAccountProvider,
  getAccountsOverview,
  getAccountsSummary,
} from '../lib/accounts.js';
import { testCustomProviderConnection } from '../lib/customProviderConnection.js';
import { saveProviderCliExecutable } from '../lib/localCliProviders.js';
import {
  customProviderStatuses,
  managedCustomProviderRecord,
  removeCustomProvider,
  removeManagedProviderCredential,
  saveCustomProvider,
  saveManagedProviderCredential,
  validateCustomProvider,
  validateProviderCredential,
} from '../lib/providerCredentials.js';

export function createAccountsRouter({
  getOverview = getAccountsOverview,
  getSummary = getAccountsSummary,
  getProvider = getAccountProvider,
  saveCredential = saveManagedProviderCredential,
  removeCredential = removeManagedProviderCredential,
  listCustomProviders = customProviderStatuses,
  createCustomProvider = saveCustomProvider,
  updateCustomProvider = saveCustomProvider,
  deleteCustomProvider = removeCustomProvider,
  getCustomProviderRecord = managedCustomProviderRecord,
  testProviderConnection = testCustomProviderConnection,
  loginManager = accountLoginManager,
  consumeReset = consumeCodexManualReset,
} = {}) {
  const router = Router();
  const builtinProviderRoute = '/:provider';

  router.get('/', async (req, res, next) => {
    try {
      const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
      res.json(await getOverview({ refresh }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/summary', (req, res, next) => {
    try {
      res.json(getSummary());
    } catch (error) {
      next(error);
    }
  });

  router.get('/provider/:provider', async (req, res, next) => {
    try {
      const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
      const provider = await getProvider(req.params.provider, { refresh });
      if (!provider) return res.status(404).json({ error: 'Unknown account provider.' });
      return res.json(provider);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/custom-providers', (req, res, next) => {
    try {
      res.json({ providers: listCustomProviders() });
    } catch (error) {
      next(error);
    }
  });

  router.post('/custom-providers', async (req, res, next) => {
    try {
      const validationError = validateCustomProvider(req.body);
      if (validationError) {
        return res.status(422).json({ error: 'Validation failed.', errors: [validationError] });
      }
      const provider = await createCustomProvider(req.body);
      return res.status(201).json({ provider });
    } catch (error) {
      if (error?.validationError) {
        return res.status(422).json({ error: 'Validation failed.', errors: [error.validationError] });
      }
      return next(error);
    }
  });

  router.put('/custom-providers/:providerId', async (req, res, next) => {
    try {
      const existing = getCustomProviderRecord(req.params.providerId);
      if (!existing) return res.status(404).json({ error: 'Custom provider not found.' });
      const validationError = validateCustomProvider(req.body, { providerId: existing.id, existingIds: new Set() });
      if (validationError) {
        return res.status(422).json({ error: 'Validation failed.', errors: [validationError] });
      }
      const provider = await updateCustomProvider(req.body, { providerId: existing.id });
      return res.json({ provider });
    } catch (error) {
      if (error?.validationError) {
        return res.status(422).json({ error: 'Validation failed.', errors: [error.validationError] });
      }
      return next(error);
    }
  });

  router.post('/custom-providers/:providerId/test', async (req, res, next) => {
    try {
      const provider = getCustomProviderRecord(req.params.providerId);
      if (!provider) return res.status(404).json({ error: 'Custom provider not found.' });
      const result = await testProviderConnection(provider);
      return res.json(result);
    } catch (error) {
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
      return next(error);
    }
  });

  router.delete('/custom-providers/:providerId', async (req, res, next) => {
    try {
      const removed = await deleteCustomProvider(req.params.providerId);
      if (!removed) return res.status(404).json({ error: 'Custom provider not found.' });
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post(builtinProviderRoute, async (req, res, next) => {
    try {
      const validationError = validateProviderCredential(req.params.provider, req.body?.credential);
      if (validationError) {
        return res.status(422).json({ error: 'Validation failed.', errors: [validationError] });
      }
      await saveCredential(req.params.provider, req.body.credential);
      return res.json(await getOverview());
    } catch (error) {
      next(error);
    }
  });

  router.post(`${builtinProviderRoute}/login`, async (req, res, next) => {
    try {
      res.status(201).json(await loginManager.start(req.params.provider, req.body?.accountId || null));
    } catch (error) {
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
      next(error);
    }
  });

  router.post(`${builtinProviderRoute}/executable`, async (req, res, next) => {
    try {
      await saveProviderCliExecutable(req.params.provider, req.body?.path);
      const provider = await getProvider(req.params.provider, { refresh: true });
      if (!provider) return res.status(404).json({ error: 'Unknown account provider.' });
      return res.json(provider);
    } catch (error) {
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
      return next(error);
    }
  });

  router.post(`${builtinProviderRoute}/refresh`, async (req, res, next) => {
    try {
      await loginManager.refreshProvider(req.params.provider);
      const provider = await getProvider(req.params.provider, { refresh: true });
      if (!provider) return res.status(404).json({ error: 'Unknown account provider.' });
      return res.json(provider);
    } catch (error) {
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
      return next(error);
    }
  });

  router.get('/login/:sessionId', (req, res, next) => {
    try {
      res.json(loginManager.get(req.params.sessionId));
    } catch (error) {
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
      next(error);
    }
  });

  router.post('/login/:sessionId/input', (req, res, next) => {
    try {
      res.json(loginManager.submit(req.params.sessionId, req.body?.code));
    } catch (error) {
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
      next(error);
    }
  });

  router.post('/codex/account/:accountId/start-weekly', async (req, res, next) => {
    try {
      await loginManager.startWeeklyUsage(req.params.accountId);
      await delay(2000);
      res.json(await getOverview({ refresh: true }));
    } catch (error) {
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
      next(error);
    }
  });

  router.post('/codex/account/:accountId/reset', async (req, res, next) => {
    try {
      if (req.body?.confirm !== 'use-reset') {
        return res.status(422).json({ error: 'Confirm before using a manual reset.' });
      }
      await consumeReset(req.params.accountId);
      await delay(2000);
      res.json(await getOverview({ refresh: true }));
    } catch (error) {
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
      next(error);
    }
  });

  router.delete('/login/:sessionId', (req, res, next) => {
    try {
      res.json(loginManager.cancel(req.params.sessionId));
    } catch (error) {
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
      next(error);
    }
  });

  router.delete(`${builtinProviderRoute}/account/:accountId`, async (req, res, next) => {
    try {
      await loginManager.removeAccount(req.params.provider, req.params.accountId);
      res.json(await getOverview({ refresh: true }));
    } catch (error) {
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
      next(error);
    }
  });

  router.delete(builtinProviderRoute, async (req, res, next) => {
    try {
      await removeCredential(req.params.provider, { disableEnvironment: true });
      res.json(await getOverview({ refresh: true }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createAccountsRouter();
