export const WORKFLOW_FILE_KIND = 'open-kritt-workflow';
export const WORKFLOW_FILE_VERSION = 1;
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
  return { name: step.name || '', content: step.content };
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
  return {
    depth: level.depth,
    multiOutput: normalizeBoolean(level.multiOutput, `${field}.multiOutput`),
    consumesAll: normalizeBoolean(consumesAll, `${field}.consumesAll`),
    outputFormat: copyOutputFormat(level.outputFormat, `${field}.outputFormat`),
    steps: level.steps.map((step, stepIndex) => normalizeStep(step, `${field}.steps[${stepIndex}]`)),
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
      return;
    }

    levels.set(step.depth, {
      depth: step.depth,
      multiOutput,
      consumesAll,
      outputFormat,
      steps: [normalizeStep(step, field)],
    });
  });

  return [...levels.values()].sort((left, right) => left.depth - right.depth);
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

  return {
    name: workflow.name.trim(),
    description: workflow.description || '',
    levels,
  };
}

export function createWorkflowExport(workflow) {
  return {
    kind: WORKFLOW_FILE_KIND,
    version: WORKFLOW_FILE_VERSION,
    workflow: normalizeWorkflow(workflow),
  };
}

export function workflowPayloadFromImport(document) {
  if (!isObjectMap(document)) throw workflowError('the JSON root must be an object.');

  if (Object.hasOwn(document, 'kind') || Object.hasOwn(document, 'version')) {
    if (document.kind !== WORKFLOW_FILE_KIND) {
      throw workflowError(`unsupported file kind "${document.kind || ''}".`);
    }
    if (document.version !== WORKFLOW_FILE_VERSION) {
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
