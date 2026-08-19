import { Router } from 'express';
import { setTimeout as delay } from 'node:timers/promises';

import { accountLoginManager } from '../lib/accountLogins.js';
import {
  consumeCodexManualReset,
  getAccountProvider,
  getAccountsOverview,
  getAccountsSummary,
} from '../lib/accounts.js';
import {
  removeManagedProviderCredential,
  saveManagedProviderCredential,
  validateProviderCredential,
} from '../lib/providerCredentials.js';

export function createAccountsRouter({
  getOverview = getAccountsOverview,
  getSummary = getAccountsSummary,
  getProvider = getAccountProvider,
  saveCredential = saveManagedProviderCredential,
  removeCredential = removeManagedProviderCredential,
  loginManager = accountLoginManager,
  consumeReset = consumeCodexManualReset,
} = {}) {
  const router = Router();

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

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

  router.post('/:provider', async (req, res, next) => {
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

  router.post('/:provider/login', async (req, res, next) => {
    try {
      res.status(201).json(await loginManager.start(req.params.provider, req.body?.accountId || null));
    } catch (error) {
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
      next(error);
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

  router.delete('/:provider/account/:accountId', async (req, res, next) => {
    try {
      await loginManager.removeAccount(req.params.provider, req.params.accountId);
      res.json(await getOverview({ refresh: true }));
    } catch (error) {
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
      next(error);
    }
  });

  router.delete('/:provider', async (req, res, next) => {
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
