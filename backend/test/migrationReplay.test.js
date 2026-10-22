import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

// Opt in only with a disposable PostgreSQL database; the runner applies every migration.
test(
  'migration replay preserves existing generation rows and rejects invalid provider pairs',
  {
    skip: !databaseUrl,
    timeout: 120000,
  },
  async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const marker = `migration-replay-${randomUUID()}`;
    const migrate = () =>
      execFileAsync(process.execPath, ['prisma/migrate.js'], {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        timeout: 30000,
      });
    try {
      await migrate();
      await migrate();
      await prisma.$executeRawUnsafe(
        `INSERT INTO public.generations (kind, request, model, model_provider, harness, status)
       VALUES ('workflow', $1, 'synthetic-model', 'deepseek', 'codex', 'completed')`,
        marker
      );
      await migrate();
      await migrate();
      const rows = await prisma.$queryRawUnsafe(
        'SELECT model_provider, harness, status FROM public.generations WHERE request = $1',
        marker
      );
      assert.deepEqual(rows, [{ model_provider: 'deepseek', harness: 'codex', status: 'completed' }]);
      await assert.rejects(
        prisma.$executeRawUnsafe(
          `INSERT INTO public.generations (kind, request, model, model_provider, harness, status)
       VALUES ('workflow', $1, 'synthetic-model', 'deepseek', 'claude-code', 'completed')`,
          marker
        ),
        /check constraint/
      );
    } finally {
      await prisma.$executeRawUnsafe('DELETE FROM public.generations WHERE request = $1', marker).catch(() => {});
      await prisma.$disconnect();
    }
  }
);
