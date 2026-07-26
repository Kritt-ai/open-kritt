import { createApp } from './app.js';
import { disconnect } from './db.js';
import { ensureDefaultSeverityRankers } from './lib/defaultSeverityRankers.js';
import { ensureDefaultWorkflows } from './lib/defaultWorkflows.js';
import { logger } from './lib/logger.js';

const PORT = process.env.BACKEND_PORT || process.env.PORT || 3002;
const HOST = process.env.BACKEND_HOST || '127.0.0.1';

const installedDefaults = await ensureDefaultWorkflows();
if (installedDefaults.length) {
  logger.info({ workflows: installedDefaults }, 'installed default workflows');
}
const installedRankers = await ensureDefaultSeverityRankers();
if (installedRankers.length) {
  logger.info({ severityRankers: installedRankers }, 'installed default severity rankers');
}

const app = createApp();
const server = app.listen(PORT, HOST, () => {
  logger.info({ host: HOST, port: PORT }, `open-kritt backend listening on http://${HOST}:${PORT}`);
});

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await disconnect();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
