import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import express from 'express';

import { assertModelSelectionAvailable } from '../src/lib/modelSelection.js';
import { validateGeneratedArtifact } from '../src/lib/serialize.js';
import { ValidationError } from '../src/lib/validation.js';
import { createGenerationsRouter } from '../src/routes/generations.js';

const now = new Date('2026-07-13T12:00:00.000Z');
const terminalOutput = {
  explanation: 'string',
  file_path: 'string',
  line: 'number',
  malicious_input_example: 'string',
  summary: 'string',
  trigger_flow: 'array',
  vulnerability_type: 'string',
  malicious_actor: 'string',
};

function generatedWorkflow() {
  return {
    name: 'external-flow-analysis',
    description: 'Discover and investigate externally reachable flows.',
    levels: [
      {
        depth: 0,
        multiOutput: true,
        consumesAll: false,
        outputFormat: { ...terminalOutput },
        steps: [{ name: 'Investigate', content: 'Investigate {{repo_full}}.' }],
      },
    ],
  };
}

function generationRow(overrides = {}) {
  return {
    id: 42n,
    kind: 'workflow',
    request: 'stored internally',
    model: 'gpt-5.6',
    modelProvider: 'codex',
    harness: 'codex',
    thinkingEffort: 'high',
    status: 'pending',
    result: null,
    error: null,
    validationErrors: null,
    rawTokenUsage: { secret_internal_usage: true },
    codexSessionId: 'internal-session',
    runStartedAt: null,
    completedAt: null,
    insertedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function requestRouter(router, path = '/', options) {
  const app = express();
  app.use(express.json());
  app.use(router);
  // Match the production ValidationError response without needing a real Prisma client.
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error instanceof ValidationError) {
      return res.status(422).json({ error: 'Validation failed.', errors: error.errors });
    }
    res.status(500).json({ error: error.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
    return { status: response.status, headers: response.headers, body: await response.json() };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('generation creation validates availability and queues only engine input fields', async () => {
  let selected;
  let createdData;
  const router = createGenerationsRouter({
    prismaClient: {
      generation: {
        create: async ({ data }) => {
          createdData = data;
          return generationRow(data);
        },
      },
    },
    ensureModelSelection: async (value) => {
      selected = value;
    },
  });

  const response = await requestRouter(router, '/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'workflow',
      request: '  Map public entrypoints.  ',
      model: 'gpt-5.6',
      modelProvider: 'codex',
      harness: 'codex-cli',
      thinkingEffort: 'high',
      status: 'completed',
      result: { attacker_supplied: true },
    }),
  });

  assert.equal(response.status, 202);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(createdData, {
    kind: 'workflow',
    request: 'Map public entrypoints.',
    model: 'gpt-5.6',
    modelProvider: 'codex',
    harness: 'codex',
    thinkingEffort: 'high',
    status: 'pending',
  });
  assert.deepEqual(selected, {
    kind: 'workflow',
    request: 'Map public entrypoints.',
    model: 'gpt-5.6',
    modelProvider: 'codex',
    harness: 'codex',
    thinkingEffort: 'high',
  });
  assert.equal(response.body.status, 'pending');
  assert.equal(response.body.result, null);
  assert.equal(response.body.request, 'Map public entrypoints.');
  assert.equal('rawTokenUsage' in response.body, false);
  assert.equal('codexSessionId' in response.body, false);
});

test('generation polling exposes only a canonically validated completed artifact', async () => {
  const result = {
    name: 'finding-summary',
    description: 'Summarize the finding.',
    content: 'Summarize {{summary}} and {{explanation}}.',
    outputFormat: { _chip_risk: 'string', _reserved_report: 'string' },
  };
  const router = createGenerationsRouter({
    prismaClient: {
      generation: {
        findUnique: async () => generationRow({ kind: 'post_script', status: 'completed', result }),
      },
    },
  });

  const response = await requestRouter(router, '/42');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.body.status, 'completed');
  assert.deepEqual(response.body.result, result);
  assert.equal(response.body.error, null);
  assert.deepEqual(response.body.validationErrors, []);
  assert.equal(response.body.request, 'stored internally');
});

test('generation polling exposes a bounded public request', async () => {
  const router = createGenerationsRouter({
    prismaClient: {
      generation: {
        findUnique: async () => generationRow({ request: `  keep\u0000me ${'x'.repeat(20_100)}  ` }),
      },
    },
  });

  const response = await requestRouter(router, '/42');
  assert.equal(response.status, 200);
  assert.equal(response.body.request.length, 20_000);
  assert.match(response.body.request, /^keep me /);
  assert.equal(response.body.request.includes('\u0000'), false);
});

test('generation polling fails closed when a completed engine result is invalid', async () => {
  const router = createGenerationsRouter({
    prismaClient: {
      generation: {
        findUnique: async () => generationRow({ status: 'completed', result: { name: 'broken', levels: [] } }),
      },
    },
  });

  const response = await requestRouter(router, '/42');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'failed');
  assert.equal(response.body.result, null);
  assert.match(response.body.error, /did not satisfy/);
  assert.ok(response.body.validationErrors.some((item) => item.field === 'levels'));
});

test('generation polling exposes safe failed-run context and structured validation issues', async () => {
  const validationErrors = [{ field: 'terminal.outputFormat', message: 'line must use type number.' }];
  const router = createGenerationsRouter({
    prismaClient: {
      generation: {
        findUnique: async () =>
          generationRow({
            status: 'failed',
            error: 'Generated draft did not pass validation.',
            validationErrors,
            rawTokenUsage: { private: 'usage' },
            codexSessionId: 'private-session',
            runStartedAt: new Date('2026-07-13T12:00:02.000Z'),
            completedAt: new Date('2026-07-13T12:00:11.000Z'),
          }),
      },
    },
  });

  const response = await requestRouter(router, '/42');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'failed');
  assert.equal(response.body.error, 'Generated draft did not pass validation.');
  assert.deepEqual(response.body.validationErrors, validationErrors);
  assert.equal(response.body.model, 'gpt-5.6');
  assert.equal(response.body.modelProvider, 'codex');
  assert.equal(response.body.harness, 'codex');
  assert.equal(response.body.thinkingEffort, 'high');
  assert.equal(response.body.runStartedAt, '2026-07-13T12:00:02.000Z');
  assert.equal(response.body.completedAt, '2026-07-13T12:00:11.000Z');
  assert.equal('rawTokenUsage' in response.body, false);
  assert.equal('codexSessionId' in response.body, false);
});

test('completed workflow generation rejects values the manual editor can coerce', () => {
  const cases = [
    ['string depth', (draft) => (draft.levels[0].depth = '0')],
    ['numeric multiOutput', (draft) => (draft.levels[0].multiOutput = 1)],
    ['string consumesAll', (draft) => (draft.levels[0].consumesAll = 'false')],
    [
      'array output format',
      (draft) => (draft.levels[0].outputFormat = Object.entries(terminalOutput).map(([key, type]) => ({ key, type }))),
    ],
    ['nested output type', (draft) => (draft.levels[0].outputFormat.line = { type: 'number' })],
    ['blank step name', (draft) => (draft.levels[0].steps[0].name = '  ')],
    ['non-string step content', (draft) => (draft.levels[0].steps[0].content = ['Investigate'])],
    ['blank description', (draft) => (draft.description = '\t')],
  ];

  for (const [label, mutate] of cases) {
    const draft = generatedWorkflow();
    mutate(draft);
    const validated = validateGeneratedArtifact('workflow', draft);
    assert.equal(validated.result, null, label);
    assert.ok(validated.errors.length > 0, label);
  }
});

test('completed post-script generation requires an exact output map and description', () => {
  const base = {
    name: 'finding-summary',
    description: 'Summarize the finding.',
    content: 'Summarize {{summary}}.',
    outputFormat: { _chip_risk: 'string' },
  };
  const cases = [
    ['JSON output format', (draft) => (draft.outputFormat = '{"_chip_risk":"string"}')],
    ['array output format', (draft) => (draft.outputFormat = [{ key: '_chip_risk', type: 'string' }])],
    ['nested output type', (draft) => (draft.outputFormat = { _chip_risk: { type: 'string' } })],
    ['blank description', (draft) => (draft.description = '  ')],
  ];

  for (const [label, mutate] of cases) {
    const draft = structuredClone(base);
    mutate(draft);
    const validated = validateGeneratedArtifact('post_script', draft);
    assert.equal(validated.result, null, label);
    assert.ok(validated.errors.length > 0, label);
  }
});

test('generation polling returns 404 for an unknown id', async () => {
  const router = createGenerationsRouter({
    prismaClient: { generation: { findUnique: async () => null } },
  });

  const response = await requestRouter(router, '/999');
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: 'Generation not found.' });
});

test('shared model availability enforces native catalogs and leaves OpenRouter unrestricted', async () => {
  await assert.rejects(
    () =>
      assertModelSelectionAvailable(
        { modelProvider: 'codex', model: 'gpt-5.6' },
        { providerConfigured: async () => false }
      ),
    (error) => error instanceof ValidationError && error.errors[0].field === 'model_provider'
  );

  await assert.rejects(
    () =>
      assertModelSelectionAvailable(
        { modelProvider: 'codex', model: 'not-cached', thinkingEffort: 'medium' },
        {
          providerConfigured: async () => true,
          getCatalog: async () => ({
            models: [{ id: 'gpt-5.6', thinkingEfforts: ['medium'] }],
            defaultModel: 'gpt-5.6',
          }),
        }
      ),
    (error) => error instanceof ValidationError && error.errors[0].field === 'model'
  );

  await assert.doesNotReject(() =>
    assertModelSelectionAvailable(
      { modelProvider: 'openrouter', model: 'custom/not-in-catalog' },
      {
        providerConfigured: async () => true,
        getCatalog: async () => ({
          models: [{ id: 'vendor/catalog-suggestion', thinkingEfforts: ['medium'] }],
          defaultModel: 'vendor/catalog-suggestion',
        }),
      }
    )
  );

  await assert.rejects(
    () =>
      assertModelSelectionAvailable(
        { modelProvider: 'codex', model: 'gpt-5.6', thinkingEffort: 'xhigh' },
        {
          providerConfigured: async () => true,
          getCatalog: async () => ({
            models: [{ id: 'gpt-5.6', thinkingEfforts: ['low', 'medium', 'high'] }],
            defaultModel: 'gpt-5.6',
          }),
        }
      ),
    (error) => error instanceof ValidationError && error.errors[0].field === 'thinking_effort'
  );
});
