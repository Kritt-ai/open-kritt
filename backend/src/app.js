import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';

import { logger } from './lib/logger.js';
import overviewRouter from './routes/overview.js';
import workflowsRouter from './routes/workflows.js';
import stepsRouter from './routes/steps.js';
import scansRouter from './routes/scans.js';
import vulnerabilitiesRouter from './routes/vulnerabilities.js';
import postScriptsRouter from './routes/postScripts.js';
import agentSkillsRouter from './routes/agentSkills.js';
import severityRankersRouter from './routes/severityRankers.js';
import localReposRouter from './routes/localRepos.js';
import modelCatalogRouter from './routes/modelCatalog.js';
import modelProvidersRouter from './routes/modelProviders.js';
import generationsRouter from './routes/generations.js';
import accountsRouter from './routes/accounts.js';
import settingsRouter from './routes/settings.js';
import { ValidationError } from './lib/validation.js';

function serializeError(error, depth = 0) {
  if (!error || depth > 4) return null;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
    statusCode: error.statusCode,
    meta: error.meta,
    cause: serializeError(error.cause, depth + 1),
  };
}

function developmentErrorsEnabled(env) {
  return !['production', 'prod'].includes(String(env.NODE_ENV || '').toLowerCase());
}

export function prismaUniqueConflict(error) {
  if (error?.code !== 'P2002') return null;
  const rawTarget = error?.meta?.target;
  const fields = (Array.isArray(rawTarget) ? rawTarget : typeof rawTarget === 'string' ? [rawTarget] : []).filter(
    (field) => typeof field === 'string' && field.length > 0
  );
  if (fields.includes('slug')) {
    return {
      status: 409,
      body: {
        error: 'Agent skill slug already exists.',
        errors: [{ field: 'slug', message: 'Choose a unique agent skill slug.' }],
      },
    };
  }
  return {
    status: 409,
    body: {
      error: 'A record with those values already exists.',
      ...(fields.length ? { errors: fields.map((field) => ({ field, message: 'This value must be unique.' })) } : {}),
    },
  };
}

export function corsOptions(env = process.env) {
  const configured = env.BACKEND_CORS_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  // The bundled frontend uses the same-origin /api proxy, so CORS is not
  // required by default. Operators exposing the API on another origin must opt
  // in to the exact browser origins that should be allowed.
  if (!configured?.length) return { origin: false };
  if (configured.includes('*')) return { origin: '*' };

  const allowed = new Set(configured);
  return {
    origin(origin, callback) {
      callback(null, !origin || allowed.has(origin));
    },
  };
}

export function createApp({ env = process.env, runtimeSettingsOptions } = {}) {
  const app = express();
  app.locals.runtimeSettingsOptions = runtimeSettingsOptions;

  app.use(cors(corsOptions(env)));
  app.use(express.json({ limit: '2mb' }));
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const existing = req.headers['x-request-id'];
        const id = (Array.isArray(existing) ? existing[0] : existing) || randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
    })
  );

  app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'open-kritt-backend' }));

  app.use('/api/overview', overviewRouter);
  app.use('/api/workflows', workflowsRouter);
  app.use('/api/steps', stepsRouter);
  app.use('/api/scans', scansRouter);
  app.use('/api/vulnerabilities', vulnerabilitiesRouter);
  app.use('/api/post-scripts', postScriptsRouter);
  app.use('/api/agent-skills', agentSkillsRouter);
  app.use('/api/severity-rankers', severityRankersRouter);
  app.use('/api/local-repos', localReposRouter);
  app.use('/api/model-providers', modelProvidersRouter);
  app.use('/api/model-catalog', modelCatalogRouter);
  app.use('/api/generations', generationsRouter);
  app.use('/api/accounts', accountsRouter);
  app.use('/api/settings', settingsRouter);

  // 404 for unknown API routes.
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // Central error handler. Validation errors become 422 with a field list.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const errorDetails = serializeError(err);
    (req.log || logger).error(
      {
        err,
        error: errorDetails,
        method: req.method,
        url: req.originalUrl,
        body: req.body,
        params: req.params,
        query: req.query,
      },
      'request failed with unhandled exception'
    );
    if (err instanceof ValidationError) {
      return res.status(422).json({ error: 'Validation failed.', errors: err.errors });
    }
    // Bad BigInt conversion from a malformed :id param.
    if (err instanceof SyntaxError && /Cannot convert .* to a BigInt/.test(err.message)) {
      return res.status(400).json({ error: 'Invalid id.' });
    }
    const uniqueConflict = prismaUniqueConflict(err);
    if (uniqueConflict) return res.status(uniqueConflict.status).json(uniqueConflict.body);
    if (err?.code === 'P2025') return res.status(404).json({ error: 'Not found.' });
    const message = developmentErrorsEnabled(env) ? err?.message || 'Internal server error.' : 'Internal server error.';
    res.status(err?.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500).json({
      error: message,
      ...(developmentErrorsEnabled(env) ? { details: errorDetails } : {}),
    });
  });

  return app;
}
