import { Router } from 'express';

import { prisma } from '../db.js';
import { buildModelCatalogResponse, hasModelCatalog } from '../lib/modelCatalog.js';
import { discoverConfiguredModelProviders } from '../lib/providerDiscovery.js';

async function findCatalogs(providerIds) {
  if (!providerIds.length) return [];
  return prisma.modelCatalog.findMany({ where: { provider: { in: providerIds } } });
}

export function createModelCatalogRouter({
  getConfiguredProviders = discoverConfiguredModelProviders,
  getCatalogs = findCatalogs,
} = {}) {
  const router = Router();

  // GET /api/model-catalog — configured provider input modes and cached models.
  router.get('/', async (req, res, next) => {
    try {
      const providers = await getConfiguredProviders();
      const catalogProviders = providers.filter(hasModelCatalog);
      const catalogs = await getCatalogs(catalogProviders);
      res.json(buildModelCatalogResponse(providers, catalogs));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

export default createModelCatalogRouter();
