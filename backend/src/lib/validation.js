// Server-side validation of the workflow and post-script rules described in the spec.
// Each validator returns { valid, errors: [{ field, message }], normalized } so the
// API can return precise 422 responses the UI can surface.

import {
  BUILTIN_KEYS,
  REQUIRED_VULN_KEYS,
  REQUIRED_KEY_TYPES,
  RESERVED_POST_SCRIPT_KEYS,
  POST_SCRIPT_MARKDOWN_OUTPUT_KEYS,
  POST_SCRIPT_CHIP_PREFIX,
  FIELD_TYPES,
  EXTRA_KEY,
  THINKING_EFFORTS,
  DEFAULT_THINKING_EFFORT,
  MODEL_PROVIDERS,
  DEFAULT_MODEL_PROVIDER,
  HARNESSES,
  HARNESS_ALIASES,
  MODEL_PROVIDER_HARNESSES,
  HARNESS_THINKING_EFFORTS,
  isModelProviderHarnessCompatible,
  GENERATION_KINDS,
  GENERATION_REQUEST_MAX_LENGTH,
  MODEL_ID_MAX_LENGTH,
  REPO_KINDS,
  LOCAL_SNAPSHOT_REVISION,
  isValidGithubRepoInput,
  normalizeGithubRepo,
  isValidKey,
  isExtraRef,
  hasMalformedTemplateRefs,
  parseRefs,
  normalizeOutputFormat,
  refResolves,
  extractExtraKeys,
  multiOutputDepthKey,
  isMultiOutputDepthKey,
} from './constants.js';

class ValidationError extends Error {
  constructor(errors) {
    super('Validation failed');
    this.name = 'ValidationError';
    this.status = 422;
    this.errors = errors;
  }
}
export { ValidationError };

function modelSelectionValidation(body, fieldPrefix = '') {
  const errors = [];
  const fieldName = (field) => (fieldPrefix ? `${fieldPrefix}.${field}` : field);
  const push = (field, message) => errors.push({ field: fieldName(field), message });

  const modelValue = body?.model;
  const model = typeof modelValue === 'string' ? modelValue.trim() : '';
  if (!model) {
    push(
      'model',
      modelValue == null || typeof modelValue === 'string' ? 'A model is required.' : 'Model must be a string.'
    );
  } else if (model.length > MODEL_ID_MAX_LENGTH) {
    push('model', `Model must be ${MODEL_ID_MAX_LENGTH} characters or fewer.`);
  }

  const providerValue = body?.model_provider ?? body?.modelProvider;
  if (providerValue != null && typeof providerValue !== 'string') {
    push('model_provider', 'Model provider must be a string.');
  }
  const rawProvider = typeof providerValue === 'string' ? providerValue.trim().toLowerCase() : DEFAULT_MODEL_PROVIDER;
  const modelProvider = rawProvider || DEFAULT_MODEL_PROVIDER;
  if (!MODEL_PROVIDERS.includes(modelProvider)) {
    push('model_provider', `Model provider must be one of: ${MODEL_PROVIDERS.join(', ')}.`);
  }

  const harnessValue = body?.harness;
  const rawHarness = typeof harnessValue === 'string' ? harnessValue.trim() : '';
  const harness = HARNESS_ALIASES[rawHarness] || rawHarness;
  if (!harness) {
    push(
      'harness',
      harnessValue == null || typeof harnessValue === 'string' ? 'A harness is required.' : 'Harness must be a string.'
    );
  } else if (!HARNESSES.includes(harness)) push('harness', `Harness must be one of: ${HARNESSES.join(', ')}.`);
  else if (MODEL_PROVIDERS.includes(modelProvider) && !isModelProviderHarnessCompatible(modelProvider, harness)) {
    push(
      'harness',
      `Harness "${harness}" is not compatible with model provider "${modelProvider}". Use ${MODEL_PROVIDER_HARNESSES[
        modelProvider
      ].join(' or ')}.`
    );
  }

  const effortValue = body?.thinking_effort ?? body?.thinkingEffort;
  if (effortValue != null && typeof effortValue !== 'string') {
    push('thinking_effort', 'Thinking effort must be a string.');
  }
  const rawEffort = typeof effortValue === 'string' ? effortValue.trim() : DEFAULT_THINKING_EFFORT;
  const thinkingEffort = rawEffort || DEFAULT_THINKING_EFFORT;
  if (!THINKING_EFFORTS.includes(thinkingEffort)) {
    push('thinking_effort', `Thinking effort must be one of: ${THINKING_EFFORTS.join(', ')}.`);
  } else if (HARNESSES.includes(harness) && !HARNESS_THINKING_EFFORTS[harness]?.includes(thinkingEffort)) {
    push('thinking_effort', `Thinking effort "${thinkingEffort}" is not supported by harness "${harness}".`);
  }

  return { errors, normalized: { model, modelProvider, harness, thinkingEffort } };
}

export function validateModelSelection(body) {
  const { errors, normalized } = modelSelectionValidation(body);
  if (errors.length) throw new ValidationError(errors);
  return normalized;
}

export function validatePostProcessingThinkingEffort(value, { harness, fallback = DEFAULT_THINKING_EFFORT } = {}) {
  const field = 'post_processing_thinking_effort';
  if (value != null && typeof value !== 'string') {
    throw new ValidationError([{ field, message: 'Post-processing thinking effort must be a string.' }]);
  }
  const normalizedFallback =
    typeof fallback === 'string' && fallback.trim() ? fallback.trim() : DEFAULT_THINKING_EFFORT;
  const effort = typeof value === 'string' && value.trim() ? value.trim() : normalizedFallback;
  if (!THINKING_EFFORTS.includes(effort)) {
    throw new ValidationError([
      { field, message: `Post-processing thinking effort must be one of: ${THINKING_EFFORTS.join(', ')}.` },
    ]);
  }
  if (HARNESSES.includes(harness) && !HARNESS_THINKING_EFFORTS[harness]?.includes(effort)) {
    throw new ValidationError([
      {
        field,
        message: `Post-processing thinking effort "${effort}" is not supported by harness "${harness}".`,
      },
    ]);
  }
  return effort;
}

export function validatePostProcessingModelSelection(value = {}, fallback = {}) {
  const selection = modelSelectionValidation({
    model: value.model ?? fallback.model,
    model_provider: value.modelProvider ?? value.model_provider ?? fallback.modelProvider ?? fallback.model_provider,
    harness: value.harness ?? fallback.harness,
    thinking_effort:
      value.thinkingEffort ?? value.thinking_effort ?? fallback.thinkingEffort ?? fallback.thinking_effort,
  });
  if (selection.errors.length) {
    const fields = {
      model: 'post_processing_model',
      model_provider: 'post_processing_model_provider',
      harness: 'post_processing_harness',
      thinking_effort: 'post_processing_thinking_effort',
    };
    throw new ValidationError(
      selection.errors.map((item) => ({
        ...item,
        field: fields[item.field] || `post_processing_${item.field}`,
      }))
    );
  }
  return selection.normalized;
}

function postProcessingRuntimeInput(body = {}, configuration = {}) {
  const config =
    configuration && typeof configuration === 'object' && !Array.isArray(configuration) ? configuration : {};
  return {
    model:
      body.post_processing_model ??
      body.postProcessingModel ??
      config.post_processing_model ??
      config.postProcessingModel,
    modelProvider:
      body.post_processing_model_provider ??
      body.postProcessingModelProvider ??
      config.post_processing_model_provider ??
      config.postProcessingModelProvider,
    harness:
      body.post_processing_harness ??
      body.postProcessingHarness ??
      config.post_processing_harness ??
      config.postProcessingHarness,
    thinkingEffort:
      body.post_processing_thinking_effort ??
      body.postProcessingThinkingEffort ??
      config.post_processing_thinking_effort ??
      config.postProcessingThinkingEffort,
  };
}

function hasPostProcessingModelOverride(value = {}) {
  return [value.model, value.modelProvider, value.harness].some((item) => item !== undefined && item !== null);
}

export function validateModelOverrides(value, { allowedDepths = null, field = 'model_overrides' } = {}) {
  if (value === undefined || value === null) return {};
  if (!isObjectMap(value)) {
    throw new ValidationError([{ field, message: 'Model overrides must be an object keyed by workflow depth.' }]);
  }

  const errors = [];
  const normalized = {};
  const entries = Object.entries(value);
  if (entries.length > 1_000) {
    errors.push({ field, message: 'Model overrides may contain at most 1,000 workflow depths.' });
  }
  const allowed = allowedDepths === null ? null : new Set([...allowedDepths].map(Number));

  for (const [rawDepth, configuration] of entries.slice(0, 1_000)) {
    const entryField = `${field}.${rawDepth}`;
    if (!/^(?:0|[1-9]\d*)$/.test(rawDepth)) {
      errors.push({ field: entryField, message: 'Workflow depth must be a non-negative integer.' });
      continue;
    }
    const depth = Number(rawDepth);
    if (!Number.isSafeInteger(depth)) {
      errors.push({ field: entryField, message: 'Workflow depth is too large.' });
      continue;
    }
    if (allowed && !allowed.has(depth)) {
      errors.push({ field: entryField, message: `Depth ${depth} does not exist in the selected workflow.` });
    }
    if (!isObjectMap(configuration)) {
      errors.push({ field: entryField, message: 'A complete model configuration is required for this depth.' });
      continue;
    }

    const selection = modelSelectionValidation(configuration, entryField);
    errors.push(...selection.errors);
    normalized[rawDepth] = {
      model: selection.normalized.model,
      model_provider: selection.normalized.modelProvider,
      harness: selection.normalized.harness,
      thinking_effort: selection.normalized.thinkingEffort,
    };
  }

  if (errors.length) throw new ValidationError(errors);
  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => Number(left) - Number(right)));
}

// ----------------------------------------------------------------------------
// Workflow validation
//
// Expected input shape (from the workflow builder):
// {
//   name: string,
//   description?: string,
//   levels: [
//     { depth: int, multiOutput: bool,
//       outputFormat: { key: type } | [{ key, type }],
//       steps: [ { name?: string, content: string } ] }
//   ]
// }
// ----------------------------------------------------------------------------
export function validateWorkflow(body) {
  const errors = [];
  const push = (field, message) => errors.push({ field, message });

  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) push('name', 'Workflow name is required.');
  if (body?.includeContextFiles !== undefined && typeof body.includeContextFiles !== 'boolean') {
    push('includeContextFiles', 'Include context files must be a boolean.');
  }
  if (body?.dedupeStep3 !== undefined && typeof body.dedupeStep3 !== 'boolean') {
    push('dedupeStep3', 'Step 3 candidate deduplication must be a boolean.');
  }
  const declaredExtraKeys = body?.extra === undefined ? [] : body.extra;
  if (!Array.isArray(declaredExtraKeys)) {
    push('extra', 'Extra input keys must be an array.');
  } else {
    if (declaredExtraKeys.length > 1_000) push('extra', 'At most 1,000 extra input keys are allowed.');
    declaredExtraKeys.slice(0, 1_000).forEach((key, index) => {
      if (!isValidKey(key)) push(`extra[${index}]`, 'Extra input keys must be safe identifier names.');
    });
  }

  const levels = Array.isArray(body?.levels) ? body.levels : null;
  if (!levels || levels.length === 0) {
    push('levels', 'At least one step (depth 0) is required.');
    throw new ValidationError(errors);
  }

  // Normalize each level's output format up front (so we can detect bad JSON).
  const normLevels = levels.map((lvl, i) => {
    let outputFormat = {};
    try {
      outputFormat = normalizeOutputFormat(lvl?.outputFormat ?? {});
    } catch {
      push(`levels[${i}].outputFormat`, 'Output format is not valid JSON.');
    }
    const rawSteps = Array.isArray(lvl?.steps) ? lvl.steps : [];
    const steps = rawSteps.map((step, stepIndex) => {
      const rawClientId = step?.clientId ?? step?.client_id ?? step?.id;
      const hasClientId = rawClientId !== undefined && rawClientId !== null;
      let clientId = `legacy:${i}:${stepIndex}`;
      if (hasClientId) {
        if (!['string', 'number'].includes(typeof rawClientId)) {
          push(`levels[${i}].steps[${stepIndex}].clientId`, 'Step ID must be a string or number.');
        } else {
          clientId = String(rawClientId).trim();
          if (!clientId) push(`levels[${i}].steps[${stepIndex}].clientId`, 'Step ID cannot be empty.');
        }
      }

      const rawBoundSourceStepId = step?.boundSourceStepId ?? step?.bound_source_step_id;
      let boundSourceStepId = null;
      if (rawBoundSourceStepId !== undefined && rawBoundSourceStepId !== null) {
        if (!['string', 'number'].includes(typeof rawBoundSourceStepId)) {
          push(
            `levels[${i}].steps[${stepIndex}].boundSourceStepId`,
            'Bound source step ID must be a string or number.'
          );
        } else {
          boundSourceStepId = String(rawBoundSourceStepId).trim();
          if (!boundSourceStepId) {
            push(`levels[${i}].steps[${stepIndex}].boundSourceStepId`, 'Bound source step ID cannot be empty.');
          }
        }
      }
      return { ...step, clientId, hasClientId, boundSourceStepId };
    });

    const rawBindPrevious = lvl?.bindPrevious ?? lvl?.bind_previous;
    if (rawBindPrevious !== undefined && typeof rawBindPrevious !== 'boolean') {
      push(`levels[${i}].bindPrevious`, 'Bind routing must be a boolean.');
    }
    const bindPrevious =
      rawBindPrevious === undefined ? steps.some((step) => step.boundSourceStepId !== null) : rawBindPrevious === true;

    return {
      depth: Number(lvl?.depth),
      multiOutput: Boolean(lvl?.multiOutput),
      consumesAll: Boolean(lvl?.consumesAll ?? lvl?.consume_all_previous),
      bindPrevious,
      outputFormat,
      steps,
    };
  });

  const levelAt = (d) => normLevels.find((l) => l.depth === d);
  // Any non-root depth may batch: even a single-step depth runs once per upstream
  // output, so the depth below it sees multiple results. We trust the opt-in and
  // only require that there be a previous depth to collapse (depth > 0).
  const effectiveConsumes = (level) => !!level.consumesAll && level.depth > 0;

  // Keys available to a step at `depth`: built-ins + earlier depths' outputs,
  // except that each batching boundary clears all branch-specific ancestor keys.
  // Already-collapsed arrays remain unambiguous and survive later boundaries.
  const availableAt = (depth) => {
    let available = new Set(BUILTIN_KEYS);
    const earlier = normLevels.filter((level) => level.depth < depth).sort((a, b) => a.depth - b.depth);
    for (const e of earlier) {
      if (e.depth >= depth) continue;
      const consumer = levelAt(e.depth + 1);
      if (consumer && effectiveConsumes(consumer)) {
        const collapsed = new Set(BUILTIN_KEYS);
        for (const key of available) {
          if (isMultiOutputDepthKey(key)) collapsed.add(key);
        }
        collapsed.add(multiOutputDepthKey(e.depth));
        available = collapsed;
      } else {
        Object.keys(e.outputFormat).forEach((key) => available.add(key));
      }
    }
    return available;
  };

  // --- depth structure ---
  const depths = normLevels.map((l) => l.depth);
  if (depths.some((d) => !Number.isInteger(d) || d < 0)) {
    push('levels', 'Every level needs a non-negative integer depth.');
  }
  const depthSet = new Set(depths);
  if (depthSet.size !== depths.length) push('levels', 'Each depth may only be defined once.');
  if (!depthSet.has(0)) push('levels', 'A step with depth 0 is required.');
  const maxDepth = Math.max(...depths);
  for (let d = 0; d <= maxDepth; d++) {
    if (!depthSet.has(d)) push('levels', `Depth ${d} is missing — depths must be contiguous from 0.`);
  }
  if (body?.dedupeStep3 === true && !depthSet.has(2)) {
    push('dedupeStep3', 'Step 3 candidate deduplication requires a workflow depth 2.');
  }
  // Depth 0 may have sibling steps too; like any level they share its output
  // format and multi_output flag (enforced structurally by the level model).

  // --- optional one-to-one routing between adjacent sibling depths ---
  const clientIds = new Map();
  for (const lvl of normLevels) {
    lvl.steps.forEach((step, stepIndex) => {
      if (!step.clientId) return;
      if (clientIds.has(step.clientId)) {
        push(
          `levels[depth=${lvl.depth}].steps[${stepIndex}].clientId`,
          `Step ID "${step.clientId}" is used more than once.`
        );
      } else {
        clientIds.set(step.clientId, { depth: lvl.depth, stepIndex });
      }
    });
  }

  for (const lvl of normLevels) {
    const boundSteps = lvl.steps.filter((step) => step.boundSourceStepId !== null);
    if (!lvl.bindPrevious) {
      if (boundSteps.length) {
        push(`levels[depth=${lvl.depth}].bindPrevious`, 'Enable bind routing before assigning bound source steps.');
      }
      continue;
    }

    if (lvl.depth === 0) {
      push(`levels[depth=${lvl.depth}].bindPrevious`, 'Depth 0 cannot bind to a previous depth.');
      continue;
    }
    if (lvl.consumesAll) {
      push(`levels[depth=${lvl.depth}].bindPrevious`, 'Bind routing cannot be combined with batch consumption.');
    }

    const previous = levelAt(lvl.depth - 1);
    if (!previous) continue;
    if (previous.steps.length < 2 || lvl.steps.length < 2) {
      push(`levels[depth=${lvl.depth}].bindPrevious`, 'Bind routing requires at least two steps in both depths.');
    }
    if (previous.steps.length !== lvl.steps.length) {
      push(
        `levels[depth=${lvl.depth}].bindPrevious`,
        `Bind routing requires the previous and current depths to have the same number of steps (${previous.steps.length} and ${lvl.steps.length}).`
      );
    }

    for (const [sourceIndex, source] of previous.steps.entries()) {
      if (!source.hasClientId) {
        push(
          `levels[depth=${previous.depth}].steps[${sourceIndex}].clientId`,
          'A stable step ID is required when the next depth uses bind routing.'
        );
      }
    }

    const previousIds = new Set(previous.steps.map((step) => step.clientId));
    const usedSourceIds = new Set();
    lvl.steps.forEach((step, stepIndex) => {
      const field = `levels[depth=${lvl.depth}].steps[${stepIndex}].boundSourceStepId`;
      if (!step.hasClientId) {
        push(
          `levels[depth=${lvl.depth}].steps[${stepIndex}].clientId`,
          'A stable step ID is required for a bound destination step.'
        );
      }
      if (!step.boundSourceStepId) {
        push(field, 'Every destination step needs a bound source step.');
        return;
      }
      if (!previousIds.has(step.boundSourceStepId)) {
        push(field, 'The bound source must be a step in the immediately previous depth.');
        return;
      }
      if (usedSourceIds.has(step.boundSourceStepId)) {
        push(field, 'Each source step can be bound to only one destination step.');
        return;
      }
      usedSourceIds.add(step.boundSourceStepId);
    });

    for (const sourceId of previousIds) {
      if (!usedSourceIds.has(sourceId)) {
        push(
          `levels[depth=${lvl.depth}].bindPrevious`,
          'Every source step must be bound to exactly one destination step.'
        );
        break;
      }
    }
  }

  // --- per-level output format + global key uniqueness ---
  const keyCount = {};
  for (const lvl of normLevels) {
    for (const k of Object.keys(lvl.outputFormat)) keyCount[k] = (keyCount[k] || 0) + 1;
  }
  for (const lvl of normLevels) {
    const keys = Object.keys(lvl.outputFormat);
    if (keys.length === 0)
      push(`levels[depth=${lvl.depth}].outputFormat`, 'Output format must define at least one key.');
    for (const [k, type] of Object.entries(lvl.outputFormat)) {
      if (!isValidKey(k)) push(`levels[depth=${lvl.depth}].outputFormat`, `"${k}" is not a valid key name.`);
      if (BUILTIN_KEYS.includes(k) || k === EXTRA_KEY || isMultiOutputDepthKey(k))
        push(`levels[depth=${lvl.depth}].outputFormat`, `"${k}" is a reserved key.`);
      if (keyCount[k] > 1)
        push(`levels[depth=${lvl.depth}].outputFormat`, `"${k}" is used more than once across the workflow.`);
      if (!FIELD_TYPES.includes(type))
        push(`levels[depth=${lvl.depth}].outputFormat`, `"${k}" has an unsupported type "${type}".`);
    }
  }

  // --- steps: content required + reference resolution ---
  // A step may reference built-in keys or keys produced by a STRICTLY earlier depth.
  for (const lvl of normLevels) {
    if (lvl.steps.length === 0) {
      push(`levels[depth=${lvl.depth}].steps`, 'Each depth must contain at least one step.');
    }
    const available = availableAt(lvl.depth);
    lvl.steps.forEach((s, si) => {
      const content = typeof s?.content === 'string' ? s.content : '';
      if (!content.trim()) push(`levels[depth=${lvl.depth}].steps[${si}].content`, 'Prompt content is required.');
      if (hasMalformedTemplateRefs(content)) {
        push(
          `levels[depth=${lvl.depth}].steps[${si}].content`,
          'Contains malformed template syntax. Use references such as {{key}} or {{extra.key}}.'
        );
      }
      const refs = [...new Set(parseRefs(content))];
      // `extra` / `extra.<key>` always resolves (dynamic built-in context).
      const bad = refs.filter((k) => !refResolves(k, available, true));
      if (bad.length) {
        push(
          `levels[depth=${lvl.depth}].steps[${si}].content`,
          `References undefined key(s): ${bad.join(', ')}. Only built-in keys, {{extra.<key>}}, or keys from earlier depths are allowed.`
        );
      }
    });
  }

  // --- terminal step must emit all required vulnerability keys ---
  const terminal = normLevels.find((l) => l.depth === maxDepth);
  if (terminal) {
    const have = new Set(Object.keys(terminal.outputFormat));
    const missing = REQUIRED_VULN_KEYS.filter((k) => !have.has(k));
    if (missing.length) {
      push(
        'terminal.outputFormat',
        `Terminal step (depth ${maxDepth}) is missing required key(s): ${missing.join(', ')}.`
      );
    }
    for (const key of REQUIRED_VULN_KEYS) {
      if (!have.has(key)) continue;
      const expected = REQUIRED_KEY_TYPES[key];
      const actual = terminal.outputFormat[key];
      if (actual !== expected) {
        push('terminal.outputFormat', `Terminal key "${key}" must use type "${expected}", not "${actual}".`);
      }
    }
    if (have.has('exploitable') && terminal.outputFormat.exploitable !== REQUIRED_KEY_TYPES.exploitable) {
      push(
        'terminal.outputFormat',
        `Terminal key "exploitable" must use type "${REQUIRED_KEY_TYPES.exploitable}", not "${terminal.outputFormat.exploitable}".`
      );
    }
  }

  if (errors.length) throw new ValidationError(errors);

  // Collect the distinct {{extra.<key>}} sub-keys referenced anywhere in the workflow.
  const referencedExtraKeys = [
    ...new Set(
      normLevels.flatMap((lvl) =>
        lvl.steps.flatMap((s) => extractExtraKeys(typeof s?.content === 'string' ? s.content : ''))
      )
    ),
  ];
  const extraKeys = [
    ...new Set([...(Array.isArray(declaredExtraKeys) ? declaredExtraKeys : []), ...referencedExtraKeys]),
  ];

  return {
    name,
    description: typeof body.description === 'string' ? body.description : null,
    includeContextFiles: body?.includeContextFiles === true,
    dedupeStep3: body?.dedupeStep3 === true,
    maxDepth,
    // Persist the EFFECTIVE batching flag (only true when the previous depth is multi).
    levels: normLevels
      .slice()
      .sort((a, b) => a.depth - b.depth)
      .map((l) => ({ ...l, consumesAll: effectiveConsumes(l) })),
    extraKeys,
  };
}

// ----------------------------------------------------------------------------
// Post-script validation
//
// Expected input:
// { name: string, content: string,
//   outputFormat: { key: type } | [{ key, type }], description?: string }
// ----------------------------------------------------------------------------
export function validatePostScript(body) {
  const errors = [];
  const push = (field, message) => errors.push({ field, message });

  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) push('name', 'Post-script name is required.');

  const content = typeof body?.content === 'string' ? body.content : '';
  if (!content.trim()) push('content', 'Content is required.');

  let outputFormat = {};
  try {
    outputFormat = normalizeOutputFormat(body?.outputFormat ?? {});
  } catch {
    push('outputFormat', 'Output format is not valid JSON.');
  }

  const keys = Object.keys(outputFormat);
  if (keys.length === 0) push('outputFormat', 'Output format must define at least one key.');
  const seen = new Set();
  for (const [k, type] of Object.entries(outputFormat)) {
    if (!isValidKey(k)) push('outputFormat', `"${k}" is not a valid key name.`);
    if (RESERVED_POST_SCRIPT_KEYS.includes(k))
      push('outputFormat', `"${k}" is a reserved key and can't be an output key.`);
    if (seen.has(k)) push('outputFormat', `"${k}" is a duplicate output key.`);
    seen.add(k);
    if (!FIELD_TYPES.includes(type)) push('outputFormat', `"${k}" has an unsupported type "${type}".`);
    if (POST_SCRIPT_MARKDOWN_OUTPUT_KEYS.includes(k) && type !== 'string') {
      push('outputFormat', `"${k}" must use type "string" so it can be rendered as Markdown.`);
    }
    if (k === POST_SCRIPT_CHIP_PREFIX) {
      push('outputFormat', `"${POST_SCRIPT_CHIP_PREFIX}" must include a label after the prefix.`);
    }
  }

  // References may only point at reserved context/finding keys.
  const allowed = new Set(RESERVED_POST_SCRIPT_KEYS);
  if (hasMalformedTemplateRefs(content)) {
    push('content', 'Contains malformed template syntax. Use references such as {{key}} or {{extra.key}}.');
  }
  const refs = [...new Set(parseRefs(content))];
  const bad = refs.filter((k) => !allowed.has(k) && !isExtraRef(k));
  if (bad.length)
    push(
      'content',
      `References non-reserved key(s): ${bad.join(', ')}. Only reserved context/finding keys are allowed.`
    );

  if (errors.length) throw new ValidationError(errors);

  return {
    name,
    content,
    description: typeof body.description === 'string' ? body.description : null,
    outputFormat,
  };
}

function isObjectMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateGeneratedText(value, field, label, push) {
  if (typeof value !== 'string') push(field, `${label} must be a string.`);
  else if (!value.trim()) push(field, `${label} is required.`);
}

function validateGeneratedOutputFormat(value, field, push) {
  if (!isObjectMap(value)) {
    push(field, 'Output format must be an object map from field names to field types.');
    return;
  }

  for (const [key, type] of Object.entries(value)) {
    if (typeof type !== 'string' || !FIELD_TYPES.includes(type)) {
      push(`${field}.${key}`, `Output field types must be one of: ${FIELD_TYPES.join(', ')}.`);
    }
  }
}

// Generated artifacts cross a trust boundary from an AI harness. Require the
// exact documented JSON shape before applying the regular semantic rules.
export function validateGeneratedWorkflow(body) {
  const errors = [];
  const push = (field, message) => errors.push({ field, message });

  if (!isObjectMap(body)) throw new ValidationError([{ field: 'result', message: 'Workflow must be an object.' }]);

  validateGeneratedText(body.name, 'name', 'Workflow name', push);
  validateGeneratedText(body.description, 'description', 'Workflow description', push);

  if (!Array.isArray(body.levels) || body.levels.length === 0) {
    push('levels', 'Workflow levels must be a non-empty array.');
  } else {
    body.levels.forEach((level, levelIndex) => {
      const levelField = `levels[${levelIndex}]`;
      if (!isObjectMap(level)) {
        push(levelField, 'Each workflow level must be an object.');
        return;
      }

      if (!Number.isInteger(level.depth) || level.depth < 0) {
        push(`${levelField}.depth`, 'Depth must be a non-negative integer.');
      }
      if (typeof level.multiOutput !== 'boolean') {
        push(`${levelField}.multiOutput`, 'multiOutput must be a boolean.');
      }
      if (typeof level.consumesAll !== 'boolean') {
        push(`${levelField}.consumesAll`, 'consumesAll must be a boolean.');
      }
      validateGeneratedOutputFormat(level.outputFormat, `${levelField}.outputFormat`, push);

      if (!Array.isArray(level.steps) || level.steps.length === 0) {
        push(`${levelField}.steps`, 'Steps must be a non-empty array.');
        return;
      }
      level.steps.forEach((step, stepIndex) => {
        const stepField = `${levelField}.steps[${stepIndex}]`;
        if (!isObjectMap(step)) {
          push(stepField, 'Each workflow step must be an object.');
          return;
        }
        validateGeneratedText(step.name, `${stepField}.name`, 'Step name', push);
        validateGeneratedText(step.content, `${stepField}.content`, 'Step content', push);
      });
    });
  }

  if (errors.length) throw new ValidationError(errors);
  return validateWorkflow(body);
}

export function validateGeneratedPostScript(body) {
  const errors = [];
  const push = (field, message) => errors.push({ field, message });

  if (!isObjectMap(body)) {
    throw new ValidationError([{ field: 'result', message: 'Post-script must be an object.' }]);
  }

  validateGeneratedText(body.name, 'name', 'Post-script name', push);
  validateGeneratedText(body.description, 'description', 'Post-script description', push);
  validateGeneratedText(body.content, 'content', 'Post-script content', push);
  validateGeneratedOutputFormat(body.outputFormat, 'outputFormat', push);

  if (errors.length) throw new ValidationError(errors);
  return validatePostScript(body);
}

// ----------------------------------------------------------------------------
// Natural-language workflow / post-script generation request validation
// ----------------------------------------------------------------------------
export function validateGeneration(body) {
  const errors = [];

  const kind = typeof body?.kind === 'string' ? body.kind.trim().toLowerCase() : '';
  if (!GENERATION_KINDS.includes(kind)) {
    errors.push({ field: 'kind', message: `Generation kind must be one of: ${GENERATION_KINDS.join(', ')}.` });
  }

  const request = typeof body?.request === 'string' ? body.request.trim() : '';
  if (!request) errors.push({ field: 'request', message: 'Describe what you want to generate.' });
  else if (request.length > GENERATION_REQUEST_MAX_LENGTH) {
    errors.push({
      field: 'request',
      message: `Generation request must be ${GENERATION_REQUEST_MAX_LENGTH.toLocaleString('en-US')} characters or fewer.`,
    });
  }

  const selection = modelSelectionValidation(body);
  errors.push(...selection.errors);
  if (errors.length) throw new ValidationError(errors);

  return { kind, request, ...selection.normalized };
}

// ----------------------------------------------------------------------------
// Agent skill validation
//
// Expected input:
// { name: string, slug?: string, description?: string, content: string,
//   sourceUrl?: string, licenseSpdx?: string, attribution?: string }
// ----------------------------------------------------------------------------
function normalizeSkillSlug(input) {
  return (input ?? '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function optionalText(body, camel, snake) {
  const value = body?.[camel] ?? body?.[snake];
  return typeof value === 'string' ? value.trim() || null : null;
}

export function validateAgentSkill(body) {
  const errors = [];
  const push = (field, message) => errors.push({ field, message });

  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) push('name', 'Skill name is required.');

  const slug = normalizeSkillSlug(body?.slug || name);
  if (!slug) push('slug', 'Skill slug is required.');

  const content = typeof body?.content === 'string' ? body.content : '';
  if (!content.trim()) push('content', 'Content is required.');

  const sourceUrl = optionalText(body, 'sourceUrl', 'source_url');
  if (sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        push('sourceUrl', 'Source URL must use http or https.');
      }
    } catch {
      push('sourceUrl', 'Source URL must be a valid URL.');
    }
  }

  if (errors.length) throw new ValidationError(errors);

  return {
    name,
    slug,
    description: typeof body?.description === 'string' ? body.description.trim() || null : null,
    content,
    sourceUrl,
    licenseSpdx: optionalText(body, 'licenseSpdx', 'license_spdx'),
    attribution: optionalText(body, 'attribution', 'attribution'),
  };
}

export function validateSeverityRanker(body) {
  const errors = [];
  const push = (field, message) => errors.push({ field, message });

  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) push('name', 'Ranker name is required.');

  const content = typeof body?.content === 'string' ? body.content : '';
  if (!content.trim()) push('content', 'Content is required.');

  if (errors.length) throw new ValidationError(errors);

  return {
    name,
    description: typeof body?.description === 'string' ? body.description.trim() || null : null,
    content,
  };
}

// ----------------------------------------------------------------------------
// Scan validation
// ----------------------------------------------------------------------------
export function validateScanJobLimit(value, field = 'jobLimit') {
  if (value === undefined || value === null || `${value}`.trim() === '') return null;
  const text = typeof value === 'number' || typeof value === 'string' ? `${value}`.trim() : '';
  if (!/^\d+$/.test(text)) {
    throw new ValidationError([{ field, message: 'Maximum model jobs must be a whole number.' }]);
  }
  const limit = Number(text);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) {
    throw new ValidationError([{ field, message: 'Maximum model jobs must be between 1 and 1,000,000.' }]);
  }
  return limit;
}

// Normalize + validate a single repo reference (the scan target or a dependency).
// `localNames` is a Set of available local repo folder names (or null to skip the
// existence check). Pushes precise field errors under `prefix`.
function normalizeRepoRef(raw, localNames, push, prefix) {
  const kind = (raw?.kind ?? raw?.repo_kind ?? raw?.repoKind ?? 'remote').toString().trim();
  const rawRepoFull = (raw?.repo_full ?? raw?.repoFull ?? '').toString().trim();
  const commitSha = (raw?.commit_sha ?? raw?.commitSha ?? '').toString().trim();

  if (!REPO_KINDS.includes(kind)) {
    push(`${prefix}.kind`, `Repo kind must be one of: ${REPO_KINDS.join(', ')}.`);
    return { kind, repoFull: rawRepoFull, commitSha: commitSha || 'HEAD' };
  }
  if (kind === 'remote') {
    const repoFull = normalizeGithubRepo(rawRepoFull);
    if (!repoFull) push(`${prefix}.repo_full`, 'A repository is required.');
    else if (!isValidGithubRepoInput(repoFull))
      push(`${prefix}.repo_full`, 'Use a GitHub repo id or URL, e.g. org/repo or https://github.com/org/repo.');
    return { kind, repoFull, commitSha: commitSha || 'HEAD' };
  }
  // Local folders are snapshotted when the scan starts, so there is no commit selector.
  const repoFull = rawRepoFull;
  if (!repoFull) push(`${prefix}.repo_full`, 'Select a local repository.');
  else if (localNames && !localNames.has(repoFull))
    push(`${prefix}.repo_full`, `Local repository "${repoFull}" was not found.`);
  return { kind, repoFull, commitSha: LOCAL_SNAPSHOT_REVISION };
}

export function validateScan(body, { localNames = null } = {}) {
  const errors = [];
  const push = (field, message) => errors.push({ field, message });

  const workflowId = body?.workflowId ?? body?.workflow_id;
  if (workflowId === undefined || workflowId === null || `${workflowId}`.trim() === '')
    push('workflowId', 'A workflow is required.');
  const postScriptId = body?.postScriptId ?? body?.post_script_id;
  if (postScriptId === undefined || postScriptId === null || `${postScriptId}`.trim() === '')
    push('postScriptId', 'A post-script is required.');
  let jobLimit = null;
  try {
    jobLimit = validateScanJobLimit(body?.jobLimit ?? body?.job_limit);
  } catch (error) {
    if (error instanceof ValidationError) errors.push(...error.errors);
    else throw error;
  }

  // Target repo (remote git URL, or a local folder under LOCAL_REPOS_PATH).
  const target = normalizeRepoRef(
    { kind: body?.repo_kind ?? body?.repoKind, repo_full: body?.repo_full, commit_sha: body?.commit_sha },
    localNames,
    push,
    'target'
  );

  const selection = modelSelectionValidation(body);
  errors.push(...selection.errors);
  let modelOverrides = {};
  try {
    modelOverrides = validateModelOverrides(body?.model_overrides ?? body?.modelOverrides);
  } catch (error) {
    if (error instanceof ValidationError) errors.push(...error.errors);
    else throw error;
  }

  // dependencies: an array of structured repo refs (remote URL+commit, or local).
  // Back-compat: a comma/space separated string is treated as remote URLs.
  let depInputs = [];
  if (Array.isArray(body?.dependencies)) depInputs = body.dependencies;
  else if (typeof body?.dependencies === 'string') {
    depInputs = body.dependencies
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => ({ kind: 'remote', repo_full: s }));
  }
  const dependencies = depInputs.map((dep, i) =>
    normalizeRepoRef(
      typeof dep === 'string' ? { kind: 'remote', repo_full: dep } : dep,
      localNames,
      push,
      `dependencies[${i}]`
    )
  );

  // configuration: accept object or JSON string.
  let configuration = {};
  if (body?.configuration && typeof body.configuration === 'object') configuration = body.configuration;
  else if (typeof body?.configuration === 'string' && body.configuration.trim()) {
    try {
      configuration = JSON.parse(body.configuration);
    } catch {
      push('configuration', 'Configuration is not valid JSON.');
    }
  }
  const postProcessingInput = postProcessingRuntimeInput(body, configuration);
  const postProcessingModelOverride = hasPostProcessingModelOverride(postProcessingInput);
  let postProcessingSelection = {
    ...selection.normalized,
    thinkingEffort: postProcessingInput.thinkingEffort ?? selection.normalized.thinkingEffort,
  };
  try {
    postProcessingSelection = validatePostProcessingModelSelection(postProcessingInput, selection.normalized);
  } catch (error) {
    if (error instanceof ValidationError) errors.push(...error.errors);
    else throw error;
  }

  // severity_ranker: required concatenated markdown ruleset for ranking findings.
  const severityRanker = (body?.severity_ranker ?? body?.severityRanker ?? '').toString();
  if (!severityRanker.trim()) push('severity_ranker', 'A severity ranker is required.');

  // extra: optional object (or JSON string) of values required by the selected prompts.
  // Required-key presence is enforced in the route, where the workflow is known.
  let extra = {};
  if (body?.extra && typeof body.extra === 'object') extra = body.extra;
  else if (typeof body?.extra === 'string' && body.extra.trim()) {
    try {
      extra = JSON.parse(body.extra);
    } catch {
      push('extra', 'Extra is not valid JSON.');
    }
  }

  if (errors.length) throw new ValidationError(errors);

  return {
    workflowId,
    postScriptId,
    repoKind: target.kind,
    repoFull: target.repoFull,
    commitSha: target.commitSha,
    repoScope: (body?.repo_scope ?? 'full repository').toString().trim() || 'full repository',
    dependencies, // [{ kind, repoFull, commitSha }]
    configuration,
    ...selection.normalized,
    postProcessingSelection,
    postProcessingModelOverride,
    postProcessingThinkingEffort: postProcessingSelection.thinkingEffort,
    modelOverrides,
    severityRanker,
    extra,
    jobLimit,
  };
}

export function validateScanRuntimeSettings(body, current = {}, options = {}) {
  return validateProspectiveScanRuntimeSettings(body, current, options).data;
}

export function validateProspectiveScanRuntimeSettings(body, current = {}, { allowedDepths = null } = {}) {
  const data = {};
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(body || {}, key);
  const bodyValue = (snakeKey, camelKey) => (hasOwn(snakeKey) ? body?.[snakeKey] : body?.[camelKey]);
  const hasModel = hasOwn('model');
  const hasProvider = hasOwn('model_provider') || hasOwn('modelProvider');
  const hasHarness = hasOwn('harness');
  const hasThinkingEffort = hasOwn('thinking_effort') || hasOwn('thinkingEffort');
  const hasPostProcessingModel = hasOwn('post_processing_model') || hasOwn('postProcessingModel');
  const hasPostProcessingModelProvider =
    hasOwn('post_processing_model_provider') || hasOwn('postProcessingModelProvider');
  const hasPostProcessingHarness = hasOwn('post_processing_harness') || hasOwn('postProcessingHarness');
  const hasPostProcessingThinkingEffort =
    hasOwn('post_processing_thinking_effort') || hasOwn('postProcessingThinkingEffort');
  const hasPostProcessingRuntime =
    hasPostProcessingModel ||
    hasPostProcessingModelProvider ||
    hasPostProcessingHarness ||
    hasPostProcessingThinkingEffort;
  const hasModelOverrides = hasOwn('model_overrides') || hasOwn('modelOverrides');

  if (
    !hasModel &&
    !hasProvider &&
    !hasHarness &&
    !hasThinkingEffort &&
    !hasPostProcessingRuntime &&
    !hasModelOverrides
  ) {
    return { data, selection: null, postProcessingSelection: null, modelOverrides: null };
  }

  const selection =
    hasModel || hasProvider || hasHarness || hasThinkingEffort
      ? validateModelSelection({
          model: hasModel ? body?.model : current.model,
          model_provider: hasProvider ? (body?.model_provider ?? body?.modelProvider) : current.modelProvider,
          harness: hasHarness ? body?.harness : current.harness,
          thinking_effort: hasThinkingEffort ? (body?.thinking_effort ?? body?.thinkingEffort) : current.thinkingEffort,
        })
      : null;
  const prospectiveSelection =
    selection ||
    validateModelSelection({
      model: current.model,
      model_provider: current.modelProvider,
      harness: current.harness,
      thinking_effort: current.thinkingEffort,
    });
  const currentConfiguration =
    current.configuration && typeof current.configuration === 'object' && !Array.isArray(current.configuration)
      ? current.configuration
      : {};
  const currentPostProcessingInput = postProcessingRuntimeInput({}, currentConfiguration);
  const clearPostProcessingModelOverride =
    hasPostProcessingModel &&
    hasPostProcessingModelProvider &&
    hasPostProcessingHarness &&
    [
      bodyValue('post_processing_model', 'postProcessingModel'),
      bodyValue('post_processing_model_provider', 'postProcessingModelProvider'),
      bodyValue('post_processing_harness', 'postProcessingHarness'),
    ].every((value) => value === null || value === '');
  const nextPostProcessingInput = clearPostProcessingModelOverride
    ? {
        thinkingEffort: hasPostProcessingThinkingEffort
          ? bodyValue('post_processing_thinking_effort', 'postProcessingThinkingEffort')
          : currentPostProcessingInput.thinkingEffort,
      }
    : {
        model: hasPostProcessingModel
          ? bodyValue('post_processing_model', 'postProcessingModel')
          : currentPostProcessingInput.model,
        modelProvider: hasPostProcessingModelProvider
          ? bodyValue('post_processing_model_provider', 'postProcessingModelProvider')
          : currentPostProcessingInput.modelProvider,
        harness: hasPostProcessingHarness
          ? bodyValue('post_processing_harness', 'postProcessingHarness')
          : currentPostProcessingInput.harness,
        thinkingEffort: hasPostProcessingThinkingEffort
          ? bodyValue('post_processing_thinking_effort', 'postProcessingThinkingEffort')
          : currentPostProcessingInput.thinkingEffort,
      };
  const postProcessingSelection = validatePostProcessingModelSelection(nextPostProcessingInput, prospectiveSelection);
  const postProcessingSelectionToCheck = selection || hasPostProcessingRuntime ? postProcessingSelection : null;
  const modelOverrides = hasModelOverrides
    ? validateModelOverrides(body?.model_overrides ?? body?.modelOverrides, { allowedDepths })
    : null;

  if (hasModel) data.model = selection.model;
  if (hasProvider) data.modelProvider = selection.modelProvider;
  if (hasHarness) data.harness = selection.harness;
  if (hasThinkingEffort) data.thinkingEffort = selection.thinkingEffort;
  if (hasPostProcessingModel || hasPostProcessingModelProvider || hasPostProcessingHarness) {
    data.postProcessingModel = clearPostProcessingModelOverride ? null : postProcessingSelection.model;
    data.postProcessingModelProvider = clearPostProcessingModelOverride ? null : postProcessingSelection.modelProvider;
    data.postProcessingHarness = clearPostProcessingModelOverride ? null : postProcessingSelection.harness;
  }
  if (hasPostProcessingThinkingEffort) data.postProcessingThinkingEffort = postProcessingSelection.thinkingEffort;
  if (hasModelOverrides) data.modelOverrides = modelOverrides;

  return { data, selection, postProcessingSelection: postProcessingSelectionToCheck, modelOverrides };
}
