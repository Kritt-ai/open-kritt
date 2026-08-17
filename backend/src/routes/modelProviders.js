import { Router } from 'express';

import { discoverConfiguredModelProviders } from '../lib/providerDiscovery.js';

const router = Router();

// GET /api/model-providers — provider IDs with usable credentials only.
router.get('/', async (req, res, next) => {
  try {
    res.json({ providers: await discoverConfiguredModelProviders() });
  } catch (e) {
    next(e);
  }
});

export default router;
