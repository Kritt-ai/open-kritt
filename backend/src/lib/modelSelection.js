import { prisma } from '../db.js';
import { modelCatalogEntry } from './modelCatalog.js';
import { isModelProviderConfigured } from './modelProviders.js';
import { ValidationError } from './validation.js';

async function findCatalog(provider) {
  return prisma.modelCatalog.findUnique({ where: { provider } });
}

export async function assertModelSelectionAvailable(
  { modelProvider, model, thinkingEffort },
  { providerConfigured = isModelProviderConfigured, getCatalog = findCatalog } = {}
) {
  if (!(await providerConfigured(modelProvider))) {
    throw new ValidationError([{ field: 'model_provider', message: 'The selected model provider is not configured.' }]);
  }

  // openrouter and xai are exempt from catalog checks (models come from their own
  // APIs). opencode is exempt because the model id is passed straight to
  // `opencode run` — there is no server-side catalog to validate against.
  if (modelProvider === 'openrouter' || modelProvider === 'xai' || modelProvider === 'opencode') return;

  const catalog = modelCatalogEntry(modelProvider, await getCatalog(modelProvider));
  if (catalog.status !== 'ready') {
    throw new ValidationError([
      { field: 'model', message: `The ${modelProvider} model catalog is not available yet.` },
    ]);
  }

  const selectedModel = catalog.models.find((candidate) => candidate.id === model);
  if (!selectedModel) {
    throw new ValidationError([
      { field: 'model', message: `Model "${model}" is not available for provider "${modelProvider}".` },
    ]);
  }

  if (thinkingEffort && !selectedModel.thinkingEfforts.includes(thinkingEffort)) {
    throw new ValidationError([
      {
        field: 'thinking_effort',
        message: `Thinking effort "${thinkingEffort}" is not available for model "${model}".`,
      },
    ]);
  }
}
