import { objectToRows } from './keys.js';

export function resultFromCompletedGeneration(job, expectedKind) {
  if (!job || typeof job !== 'object') throw new Error('The generated draft could not be loaded.');
  if (job.status !== 'completed') {
    const message = job.error || `Generation is ${job.status || 'not complete'}.`;
    throw new Error(message);
  }
  if (job.kind !== expectedKind)
    throw new Error(`This generation does not contain a ${expectedKind.replace('_', '-')}.`);
  if (!job.result || typeof job.result !== 'object' || Array.isArray(job.result)) {
    throw new Error('The completed generation has no draft result.');
  }
  return job.result;
}

export function workflowBuilderFromGeneration(result, nextId) {
  if (typeof result?.name !== 'string' || !Array.isArray(result?.levels) || result.levels.length === 0) {
    throw new Error('The generated workflow has an invalid structure.');
  }

  const levels = result.levels.map((level) => {
    if (!Number.isInteger(level?.depth) || !Array.isArray(level?.steps) || level.steps.length === 0) {
      throw new Error('The generated workflow has an invalid depth.');
    }
    return {
      depth: level.depth,
      multiOutput: level.multiOutput === true,
      consumesAll: level.consumesAll === true,
      schema: objectToRows(level.outputFormat),
      steps: level.steps.map((step) => {
        if (typeof step?.name !== 'string' || typeof step?.content !== 'string') {
          throw new Error('The generated workflow has an invalid step.');
        }
        return { id: nextId(), name: step.name, content: step.content };
      }),
    };
  });
  levels.sort((left, right) => left.depth - right.depth);

  return {
    name: result.name,
    description: typeof result.description === 'string' ? result.description : '',
    schemaMode: 'visual',
    selStepId: levels[0].steps[0].id,
    levels,
  };
}

export function postScriptDraftFromGeneration(result) {
  if (
    typeof result?.name !== 'string' ||
    typeof result?.content !== 'string' ||
    !result.outputFormat ||
    typeof result.outputFormat !== 'object' ||
    Array.isArray(result.outputFormat)
  ) {
    throw new Error('The generated post-script has an invalid structure.');
  }
  return {
    name: result.name,
    description: typeof result.description === 'string' ? result.description : '',
    content: result.content,
    rows: objectToRows(result.outputFormat),
  };
}
