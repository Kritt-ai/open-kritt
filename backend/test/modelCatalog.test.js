import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import express from 'express';

import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { buildModelCatalogResponse, isCachedModel, modelCatalogModels } from '../src/lib/modelCatalog.js';
import { createModelCatalogRouter } from '../src/routes/modelCatalog.js';

async function requestRouter(router) {
  const app = express();
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function requestApp(path, options) {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('model catalog helpers sanitize cached models and report input readiness', () => {
  const codexCatalog = {
    provider: 'codex',
    models: [
      {
        id: ' gpt-5-codex ',
        label: ' GPT-5 Codex ',
        note: ' Recommended for code analysis ',
        noteUrl: ' https://chatgpt.com/cyber ',
        thinkingEfforts: ['low', 'medium', 'max', 'ultra', 'invalid', 'low'],
      },
      'gpt-5-codex',
      '',
      null,
      {
        id: 'gpt-5-mini',
        note: 'Untrusted link omitted',
        noteUrl: 'javascript:alert(1)',
        thinking_efforts: ['high', 'xhigh', 'unsupported'],
      },
    ],
    defaultModel: 'gpt-5-codex',
  };

  assert.deepEqual(modelCatalogModels(codexCatalog), [
    {
      id: 'gpt-5-codex',
      label: 'GPT-5 Codex',
      note: 'Recommended for code analysis',
      noteUrl: 'https://chatgpt.com/cyber',
      thinkingEfforts: ['low', 'medium', 'max', 'ultra'],
      isDefault: true,
    },
    {
      id: 'gpt-5-mini',
      label: 'gpt-5-mini',
      note: 'Untrusted link omitted',
      thinkingEfforts: ['high', 'xhigh'],
      isDefault: false,
    },
  ]);
  assert.deepEqual(
    buildModelCatalogResponse(
      ['codex', 'claude', 'openrouter'],
      [codexCatalog, { provider: 'claude', models: [], lastError: 'upstream unavailable' }]
    ),
    {
      providers: [
        {
          provider: 'codex',
          input: 'select',
          models: [
            {
              id: 'gpt-5-codex',
              label: 'GPT-5 Codex',
              note: 'Recommended for code analysis',
              noteUrl: 'https://chatgpt.com/cyber',
              thinkingEfforts: ['low', 'medium', 'max', 'ultra'],
              isDefault: true,
            },
            {
              id: 'gpt-5-mini',
              label: 'gpt-5-mini',
              note: 'Untrusted link omitted',
              thinkingEfforts: ['high', 'xhigh'],
              isDefault: false,
            },
          ],
          defaultModel: 'gpt-5-codex',
          status: 'ready',
        },
        {
          provider: 'claude',
          input: 'select',
          models: [
            {
              id: 'claude-fable-5',
              label: 'Fable 5',
              note: 'Cyber requests may route to Opus 4.8.',
              thinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
              isDefault: false,
            },
            {
              id: 'claude-opus-5',
              label: 'Opus 5',
              thinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
              isDefault: false,
            },
            {
              id: 'claude-opus-4-8',
              label: 'Opus 4.8',
              thinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
              isDefault: false,
            },
            {
              id: 'claude-opus-4-7',
              label: 'Opus 4.7',
              thinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
              isDefault: false,
            },
            {
              id: 'claude-opus-4-6',
              label: 'Opus 4.6',
              thinkingEfforts: ['low', 'medium', 'high', 'max'],
              isDefault: false,
            },
            {
              id: 'claude-sonnet-5',
              label: 'Sonnet 5',
              thinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
              isDefault: true,
            },
          ],
          defaultModel: 'claude-sonnet-5',
          status: 'ready',
        },
        { provider: 'openrouter', input: 'text', models: [], defaultModel: null, status: 'loading' },
      ],
    }
  );
  assert.equal(buildModelCatalogResponse(['codex']).providers[0].status, 'loading');
  assert.equal(
    buildModelCatalogResponse(['codex'], [{ provider: 'codex', models: [{ id: 'gpt-5-codex' }] }]).providers[0].status,
    'loading'
  );
  assert.equal(
    buildModelCatalogResponse(
      ['codex'],
      [
        {
          provider: 'codex',
          models: [{ id: 'gpt-5-codex' }],
          defaultModel: 'gpt-5-codex',
          lastError: 'refresh failed',
        },
      ]
    ).providers[0].status,
    'ready'
  );
});

test('cached model lookup identifies exact catalog entries', () => {
  const catalog = { models: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex' }], defaultModel: 'gpt-5-codex' };

  assert.equal(isCachedModel('codex', 'gpt-5-codex', catalog), true);
  assert.equal(isCachedModel('codex', 'gpt-5-codex', { models: [{ id: 'gpt-5-codex' }] }), true);
  assert.equal(isCachedModel('codex', 'gpt-5-codex', { ...catalog, lastError: 'refresh failed' }), true);
  assert.equal(isCachedModel('codex', 'other-model', catalog), false);
  assert.equal(isCachedModel('claude', 'claude-sonnet-5', null), true);
  assert.equal(isCachedModel('claude', 'claude-fable-5', null), true);
  assert.equal(isCachedModel('claude', 'claude-opus-5', null), true);
  assert.equal(isCachedModel('claude', 'claude-opus-4-8', null), true);
  assert.equal(isCachedModel('claude', 'claude-sonnet-4', null), false);
  assert.equal(isCachedModel('openrouter', 'any/provider-model', null), false);
});

test('a last refresh error retains a previously valid cached catalog', () => {
  const catalog = {
    provider: 'codex',
    models: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex' }],
    defaultModel: 'gpt-5-codex',
    lastError: 'upstream unavailable',
  };

  assert.equal(buildModelCatalogResponse(['codex'], [catalog]).providers[0].status, 'ready');
  assert.equal(isCachedModel('codex', 'gpt-5-codex', catalog), true);
});

test('OpenRouter exposes cached suggestions while keeping free-text input', () => {
  const catalog = {
    provider: 'openrouter',
    models: [
      {
        id: ' vendor/code-model ',
        label: ' Code Model ',
        thinkingEfforts: ['default', 'medium', 'unsupported', 'medium'],
      },
      { id: 'vendor/backup-model', thinking_efforts: ['low', 'high'] },
    ],
    defaultModel: 'vendor/code-model',
    lastError: 'the latest refresh failed',
  };

  assert.deepEqual(buildModelCatalogResponse(['openrouter'], [catalog]), {
    providers: [
      {
        provider: 'openrouter',
        input: 'text',
        models: [
          {
            id: 'vendor/code-model',
            label: 'Code Model',
            thinkingEfforts: ['default', 'medium'],
            isDefault: true,
          },
          {
            id: 'vendor/backup-model',
            label: 'vendor/backup-model',
            thinkingEfforts: ['low', 'high'],
            isDefault: false,
          },
        ],
        defaultModel: 'vendor/code-model',
        status: 'ready',
      },
    ],
  });
  assert.equal(isCachedModel('openrouter', 'vendor/code-model', catalog), true);
  assert.equal(isCachedModel('openrouter', 'custom/not-in-catalog', catalog), false);
  assert.equal(
    buildModelCatalogResponse(['openrouter'], [{ provider: 'openrouter', models: [], lastError: 'refresh failed' }])
      .providers[0].status,
    'unavailable'
  );
});

test('model catalog endpoint returns only configured providers', async () => {
  let requestedCatalogProviders;
  const router = createModelCatalogRouter({
    getConfiguredProviders: () => ['codex', 'openrouter'],
    getCatalogs: async (providerIds) => {
      requestedCatalogProviders = providerIds;
      return [
        {
          provider: 'codex',
          models: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex', thinkingEfforts: ['medium'] }],
          defaultModel: 'gpt-5-codex',
        },
        {
          provider: 'openrouter',
          models: [{ id: 'vendor/code-model', label: 'Code Model', thinkingEfforts: ['default', 'high'] }],
          defaultModel: 'vendor/code-model',
        },
      ];
    },
  });

  const response = await requestRouter(router);
  assert.equal(response.status, 200);
  assert.deepEqual(requestedCatalogProviders, ['codex', 'openrouter']);
  assert.deepEqual(response.body, {
    providers: [
      {
        provider: 'codex',
        input: 'select',
        models: [
          {
            id: 'gpt-5-codex',
            label: 'GPT-5 Codex',
            thinkingEfforts: ['medium'],
            isDefault: true,
          },
        ],
        defaultModel: 'gpt-5-codex',
        status: 'ready',
      },
      {
        provider: 'openrouter',
        input: 'text',
        models: [
          {
            id: 'vendor/code-model',
            label: 'Code Model',
            thinkingEfforts: ['default', 'high'],
            isDefault: true,
          },
        ],
        defaultModel: 'vendor/code-model',
        status: 'ready',
      },
    ],
  });
});

test('scan creation rejects an effort unsupported by a known catalog model', async (t) => {
  const previousCodexKey = process.env.CODEX_API_KEY;
  const originalFindUnique = prisma.modelCatalog.findUnique;
  process.env.CODEX_API_KEY = 'test-key';
  prisma.modelCatalog.findUnique = async () => ({
    provider: 'codex',
    models: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex', thinkingEfforts: ['low'] }],
    defaultModel: 'gpt-5-codex',
  });
  t.after(() => {
    prisma.modelCatalog.findUnique = originalFindUnique;
    if (previousCodexKey === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = previousCodexKey;
  });

  const response = await requestApp('/api/scans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflowId: '1',
      postScriptId: '1',
      repo_kind: 'remote',
      repo_full: 'open-kritt/open-kritt',
      commit_sha: 'HEAD',
      model: 'gpt-5-codex',
      model_provider: 'codex',
      harness: 'codex',
      thinking_effort: 'high',
      severity_ranker: 'Rank by impact.',
    }),
  });

  assert.equal(response.status, 422);
  assert.deepEqual(response.body, {
    error: 'Validation failed.',
    errors: [
      {
        field: 'thinking_effort',
        message: 'Thinking effort "high" is not available for model "gpt-5-codex".',
      },
    ],
  });
});
