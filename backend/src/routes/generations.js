import { Router } from 'express';

import { prisma } from '../db.js';
import { logger } from '../lib/logger.js';
import { assertModelSelectionAvailable } from '../lib/modelSelection.js';
import { discoverConfiguredModelProviders } from '../lib/providerDiscovery.js';
import { serializeGeneration } from '../lib/serialize.js';
import { validateGeneration } from '../lib/validation.js';

export function createGenerationsRouter({
  prismaClient = prisma,
  ensureModelSelection = assertModelSelectionAvailable,
} = {}) {
  const router = Router();

  // POST /api/generations - enqueue a natural-language draft request.
  router.post('/', async (req, res, next) => {
    try {
      const knownProviders = await discoverConfiguredModelProviders();
      const valid = validateGeneration(req.body, { knownProviders });
      logger.info(
        {
          kind: valid.kind,
          modelProvider: valid.modelProvider,
          model: valid.model,
          harness: valid.harness,
          thinkingEffort: valid.thinkingEffort,
        },
        'enqueueing generation'
      );
      await ensureModelSelection(valid, {
        providerConfigured: async (provider) => knownProviders.includes(provider),
      });
      const generation = await prismaClient.generation.create({
        data: {
          kind: valid.kind,
          request: valid.request,
          model: valid.model,
          modelProvider: valid.modelProvider,
          harness: valid.harness,
          thinkingEffort: valid.thinkingEffort,
          status: 'pending',
        },
      });
      logger.info({ generationId: generation.id.toString(), status: generation.status }, 'generation enqueued');
      res.set('Cache-Control', 'no-store').status(202).json(serializeGeneration(generation));
    } catch (error) {
      logger.error(
        {
          err: error,
          error: {
            name: error?.name,
            message: error?.message,
            stack: error?.stack,
            code: error?.code,
            meta: error?.meta,
            cause: error?.cause
              ? {
                  name: error.cause.name,
                  message: error.cause.message,
                  stack: error.cause.stack,
                  code: error.cause.code,
                }
              : null,
          },
          body: req.body,
        },
        'generation enqueue failed'
      );
      next(error);
    }
  });

  // GET /api/generations/:id - poll engine-owned execution state and a validated draft.
  router.get('/:id', async (req, res, next) => {
    try {
      const generation = await prismaClient.generation.findUnique({ where: { id: BigInt(req.params.id) } });
      if (!generation) return res.status(404).json({ error: 'Generation not found.' });
      res.set('Cache-Control', 'no-store').json(serializeGeneration(generation));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createGenerationsRouter();
