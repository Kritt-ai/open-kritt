export const WORKFLOW_FILE_KIND = 'open-kritt-workflow';
export const WORKFLOW_FILE_VERSION = 2;
export const WORKFLOW_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

function isObjectMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function workflowError(message) {
  return new Error(`Invalid workflow file: ${message}`);
}

function copyOutputFormat(value, field) {
  if (!isObjectMap(value)) throw workflowError(`${field} must be an object.`);
  return Object.fromEntries(Object.entries(value));
}

function normalizeStep(step, field) {
  if (!isObjectMap(step)) throw workflowError(`${field} must be an object.`);
  if (step.name !== undefined && step.name !== null && typeof step.name !== 'string') {
    throw workflowError(`${field}.name must be a string.`);
  }
  if (typeof step.content !== 'string') throw workflowError(`${field}.content must be a string.`);
  const normalized = { name: step.name || '', content: step.content };
  const rawClientId = step.clientId ?? step.client_id ?? step.id;
  if (rawClientId !== undefined && rawClientId !== null) {
    if (!['string', 'number'].includes(typeof rawClientId) || !String(rawClientId).trim()) {
      throw workflowError(`${field}.clientId must be a non-empty string or number.`);
    }
    normalized.clientId = String(rawClientId).trim();
  }
  const rawBoundSourceStepId = step.boundSourceStepId ?? step.bound_source_step_id;
  if (rawBoundSourceStepId !== undefined && rawBoundSourceStepId !== null) {
    if (!['string', 'number'].includes(typeof rawBoundSourceStepId) || !String(rawBoundSourceStepId).trim()) {
      throw workflowError(`${field}.boundSourceStepId must be a non-empty string or number.`);
    }
    normalized.boundSourceStepId = String(rawBoundSourceStepId).trim();
  }
  return normalized;
}

function normalizeBoolean(value, field) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw workflowError(`${field} must be a boolean.`);
  return value;
}

function normalizeLevel(level, index) {
  const field = `workflow.levels[${index}]`;
  if (!isObjectMap(level)) throw workflowError(`${field} must be an object.`);
  if (!Number.isInteger(level.depth) || level.depth < 0) {
    throw workflowError(`${field}.depth must be a non-negative integer.`);
  }
  if (!Array.isArray(level.steps) || level.steps.length === 0) {
    throw workflowError(`${field}.steps must contain at least one step.`);
  }
  const consumesAll = level.consumesAll ?? level.consumeAll ?? level.consume_all_previous;
  const steps = level.steps.map((step, stepIndex) => normalizeStep(step, `${field}.steps[${stepIndex}]`));
  const rawBindPrevious = level.bindPrevious ?? level.bind_previous;
  return {
    depth: level.depth,
    multiOutput: normalizeBoolean(level.multiOutput, `${field}.multiOutput`),
    consumesAll: normalizeBoolean(consumesAll, `${field}.consumesAll`),
    bindPrevious:
      rawBindPrevious === undefined
        ? steps.some((step) => step.boundSourceStepId !== undefined)
        : normalizeBoolean(rawBindPrevious, `${field}.bindPrevious`),
    outputFormat: copyOutputFormat(level.outputFormat, `${field}.outputFormat`),
    steps,
  };
}

function outputFormatSignature(outputFormat) {
  return JSON.stringify(Object.entries(outputFormat).sort(([left], [right]) => left.localeCompare(right)));
}

function levelsFromSerializedSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw workflowError('workflow.steps must contain at least one step.');
  }

  const levels = new Map();
  steps.forEach((step, index) => {
    const field = `workflow.steps[${index}]`;
    if (!isObjectMap(step)) throw workflowError(`${field} must be an object.`);
    if (!Number.isInteger(step.depth) || step.depth < 0) {
      throw workflowError(`${field}.depth must be a non-negative integer.`);
    }

    const outputFormat = copyOutputFormat(step.outputFormat, `${field}.outputFormat`);
    const multiOutput = normalizeBoolean(step.multiOutput, `${field}.multiOutput`);
    const consumesAll = normalizeBoolean(
      step.consumesAll ?? step.consumeAll ?? step.consume_all_previous,
      `${field}.consumesAll`
    );
    const existing = levels.get(step.depth);
    if (existing) {
      const schemaMatches = outputFormatSignature(existing.outputFormat) === outputFormatSignature(outputFormat);
      if (existing.multiOutput !== multiOutput || existing.consumesAll !== consumesAll || !schemaMatches) {
        throw workflowError(`steps at depth ${step.depth} must share one output format and execution configuration.`);
      }
      existing.steps.push(normalizeStep(step, field));
      existing.bindPrevious = existing.steps.some((candidate) => candidate.boundSourceStepId !== undefined);
      return;
    }

    levels.set(step.depth, {
      depth: step.depth,
      multiOutput,
      consumesAll,
      bindPrevious: step.boundSourceStepId != null || step.bound_source_step_id != null,
      outputFormat,
      steps: [normalizeStep(step, field)],
    });
  });

  return [...levels.values()].sort((left, right) => left.depth - right.depth);
}

function validateBindings(levels) {
  const allClientIds = new Set();
  for (const [levelIndex, level] of levels.entries()) {
    for (const [stepIndex, step] of level.steps.entries()) {
      if (!step.clientId) continue;
      if (allClientIds.has(step.clientId)) {
        throw workflowError(`workflow.levels[${levelIndex}].steps[${stepIndex}].clientId is duplicated.`);
      }
      allClientIds.add(step.clientId);
    }
  }

  for (const [levelIndex, level] of levels.entries()) {
    const field = `workflow.levels[${levelIndex}]`;
    const hasBoundSources = level.steps.some((step) => step.boundSourceStepId !== undefined);
    if (!level.bindPrevious) {
      if (hasBoundSources) throw workflowError(`${field} has bound sources while bindPrevious is false.`);
      continue;
    }
    if (level.depth === 0) throw workflowError(`${field} cannot bind depth 0 to a previous depth.`);
    if (level.consumesAll) throw workflowError(`${field} cannot combine bind routing with consumesAll.`);
    const previous = levels.find((candidate) => candidate.depth === level.depth - 1);
    if (!previous) throw workflowError(`${field} has no immediately previous depth to bind.`);
    if (previous.steps.length < 2 || level.steps.length < 2) {
      throw workflowError(`${field} bind routing requires at least two steps in both depths.`);
    }
    if (previous.steps.length !== level.steps.length) {
      throw workflowError(`${field} must have the same number of steps as its bound source depth.`);
    }
    if (previous.steps.some((step) => !step.clientId) || level.steps.some((step) => !step.clientId)) {
      throw workflowError(`${field} requires stable clientId values for every source and destination step.`);
    }
    const previousIds = new Set(previous.steps.map((step) => step.clientId));
    const used = new Set();
    for (const [stepIndex, step] of level.steps.entries()) {
      const sourceId = step.boundSourceStepId;
      if (!sourceId || !previousIds.has(sourceId)) {
        throw workflowError(
          `${field}.steps[${stepIndex}].boundSourceStepId must reference the immediately previous depth.`
        );
      }
      if (used.has(sourceId)) {
        throw workflowError(`${field}.steps[${stepIndex}].boundSourceStepId is used more than once.`);
      }
      used.add(sourceId);
    }
  }
}

function normalizeWorkflow(workflow) {
  if (!isObjectMap(workflow)) throw workflowError('workflow must be an object.');
  if (typeof workflow.name !== 'string' || !workflow.name.trim()) {
    throw workflowError('workflow.name is required.');
  }
  if (workflow.description !== undefined && workflow.description !== null && typeof workflow.description !== 'string') {
    throw workflowError('workflow.description must be a string.');
  }

  let levels;
  if (Array.isArray(workflow.levels)) {
    if (workflow.levels.length === 0) throw workflowError('workflow.levels must contain at least one depth.');
    levels = workflow.levels.map(normalizeLevel).sort((left, right) => left.depth - right.depth);
  } else {
    levels = levelsFromSerializedSteps(workflow.steps);
  }
  validateBindings(levels);

  return {
    name: workflow.name.trim(),
    description: workflow.description || '',
    levels,
  };
}

export function createWorkflowExport(workflow) {
  const normalized = normalizeWorkflow(workflow);
  const portableIds = new Map();
  let nextStepNumber = 1;
  for (const level of normalized.levels) {
    for (const step of level.steps) {
      const portableId = `step-${nextStepNumber++}`;
      if (step.clientId) portableIds.set(step.clientId, portableId);
      step.clientId = portableId;
    }
  }
  for (const level of normalized.levels) {
    for (const step of level.steps) {
      if (step.boundSourceStepId) step.boundSourceStepId = portableIds.get(step.boundSourceStepId);
    }
  }
  return {
    kind: WORKFLOW_FILE_KIND,
    version: WORKFLOW_FILE_VERSION,
    workflow: normalized,
  };
}

export function workflowPayloadFromImport(document) {
  if (!isObjectMap(document)) throw workflowError('the JSON root must be an object.');

  if (Object.hasOwn(document, 'kind') || Object.hasOwn(document, 'version')) {
    if (document.kind !== WORKFLOW_FILE_KIND) {
      throw workflowError(`unsupported file kind "${document.kind || ''}".`);
    }
    if (![1, WORKFLOW_FILE_VERSION].includes(document.version)) {
      throw workflowError(`unsupported ${WORKFLOW_FILE_KIND} version "${document.version ?? ''}".`);
    }
    return normalizeWorkflow(document.workflow);
  }

  // Bare builder/API workflow objects are accepted for compatibility with
  // workflows copied manually from an existing open-kritt installation.
  return normalizeWorkflow(document);
}

export function parseWorkflowImport(contents) {
  let document;
  try {
    document = JSON.parse(contents);
  } catch {
    throw new Error('The selected file is not valid JSON.');
  }
  return workflowPayloadFromImport(document);
}

export function workflowExportFilename(name) {
  const slug = `${name || ''}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return `${slug || 'workflow'}.workflow.json`;
}

export function downloadWorkflowExport(workflow) {
  const contents = `${JSON.stringify(createWorkflowExport(workflow), null, 2)}\n`;
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = workflowExportFilename(workflow?.name);
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
