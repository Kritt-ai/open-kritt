import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, apiErrorMessages } from '../api/client.js';
import { usePageChrome } from '../context/ui.jsx';
import { useUnsavedChangesPrompt } from '../lib/useUnsavedChangesPrompt.js';
import { useModalDialog } from '../lib/useModalDialog.js';
import { Button, ErrorState, Spinner, Toggle } from '../components/ui.jsx';
import { PromptEditor } from '../components/PromptEditor.jsx';
import SchemaEditor from '../components/SchemaEditor.jsx';
import { resultFromCompletedGeneration, workflowBuilderFromGeneration } from '../lib/generationDraft.js';
import {
  BUILTIN_KEYS,
  EXTRA_KEY,
  FIELD_TYPES,
  OPTIONAL_VULN_KEYS,
  REQUIRED_VULN_KEYS,
  REQUIRED_KEY_TYPES,
  parseTemplateRefs,
  rowsToObject,
  objectToRows,
  refResolves,
  multiOutputDepthKey,
  isMultiOutputDepthKey,
  isValidKey,
} from '../lib/keys.js';

let UID = 100;
const uid = () => `b${++UID}`;

function blankBuilder() {
  return {
    name: 'untitled-workflow',
    description: '',
    extra: [],
    includeContextFiles: false,
    dedupeStep3: false,
    schemaMode: 'visual',
    selStepId: 'b0',
    levels: [
      {
        depth: 0,
        multiOutput: true,
        consumesAll: false,
        bindPrevious: false,
        schema: [{ key: 'entrypoints', type: 'array' }],
        steps: [
          {
            id: 'b0',
            name: 'Map external entrypoints',
            content:
              'Analyze {{repo_full}} at commit {{commit_sha}}.\nScope: {{repo_scope}}. Dependencies: {{dependencies}}.',
            boundSourceStepId: null,
          },
        ],
      },
    ],
  };
}

function workflowSnapshot(builder) {
  return JSON.stringify({
    name: builder.name,
    description: builder.description,
    extra: builder.extra,
    includeContextFiles: builder.includeContextFiles,
    dedupeStep3: builder.dedupeStep3,
    levels: builder.levels,
  });
}

export function workflowDraftIsDirty(builder, initialSnapshot, unsavedSource = false) {
  return !!builder && (unsavedSource || (initialSnapshot !== null && workflowSnapshot(builder) !== initialSnapshot));
}

export function workflowBindingErrors(levels) {
  if (!Array.isArray(levels)) return ['Workflow levels are required'];
  const errors = [];
  const ordered = [...levels].sort((left, right) => left.depth - right.depth);
  const stepIds = new Set();
  for (const level of ordered) {
    for (const step of level.steps || []) {
      if (!step.id || stepIds.has(step.id)) errors.push('Every workflow step needs a unique stable ID');
      else stepIds.add(step.id);
    }
  }

  for (const level of ordered) {
    const boundSteps = (level.steps || []).filter((step) => step.boundSourceStepId != null);
    if (!level.bindPrevious) {
      if (boundSteps.length) errors.push(`Depth ${level.depth}: enable bind routing or clear its bound sources`);
      continue;
    }
    if (level.depth === 0) {
      errors.push('Depth 0 cannot bind to a previous depth');
      continue;
    }
    if (level.consumesAll) errors.push(`Depth ${level.depth}: bind routing cannot be combined with all-at-once input`);
    const previous = ordered.find((candidate) => candidate.depth === level.depth - 1);
    if (!previous) {
      errors.push(`Depth ${level.depth}: the bound source depth is missing`);
      continue;
    }
    if (previous.steps.length < 2 || level.steps.length < 2) {
      errors.push(`Depth ${level.depth}: bind routing requires at least two steps in both depths`);
    }
    if (previous.steps.length !== level.steps.length) {
      errors.push(
        `Depth ${level.depth}: bind routing needs equal step counts (${previous.steps.length} and ${level.steps.length})`
      );
    }
    const previousIds = new Set(previous.steps.map((step) => step.id));
    const used = new Set();
    for (const step of level.steps) {
      if (!step.boundSourceStepId) {
        errors.push(`Depth ${level.depth}: every destination needs a bound source`);
      } else if (!previousIds.has(step.boundSourceStepId)) {
        errors.push(`Depth ${level.depth}: bound sources must come from depth ${level.depth - 1}`);
      } else if (used.has(step.boundSourceStepId)) {
        errors.push(`Depth ${level.depth}: each source can be bound only once`);
      } else {
        used.add(step.boundSourceStepId);
      }
    }
    if ([...previousIds].some((sourceId) => !used.has(sourceId))) {
      errors.push(`Depth ${level.depth}: every source must be bound exactly once`);
    }
  }
  return [...new Set(errors)];
}

function workflowLevelBindingIsValid(levels, level) {
  if (!level.bindPrevious) return true;
  if (level.depth === 0 || level.consumesAll) return false;

  const previous = levels.find((candidate) => candidate.depth === level.depth - 1);
  if (!previous || previous.steps.length < 2 || level.steps.length < 2) return false;
  if (previous.steps.length !== level.steps.length) return false;

  const previousIds = new Set(previous.steps.map((step) => step.id));
  const boundSourceIds = level.steps.map((step) => step.boundSourceStepId);
  return (
    boundSourceIds.every((sourceId) => sourceId && previousIds.has(sourceId)) &&
    new Set(boundSourceIds).size === boundSourceIds.length
  );
}

export function clearInvalidWorkflowBindings(levels) {
  if (!Array.isArray(levels)) return levels;
  for (const level of levels) {
    if (workflowLevelBindingIsValid(levels, level)) continue;
    level.bindPrevious = false;
    level.steps.forEach((step) => (step.boundSourceStepId = null));
  }
  return levels;
}

export function workflowCanShowBindRouting(sourceLevel, destinationLevel) {
  return (sourceLevel?.steps?.length || 0) >= 2 && (destinationLevel?.steps?.length || 0) >= 2;
}

const BINDING_ROUTE_COLOR_COUNT = 6;

export function workflowBindingRouteToken(sourceIndex) {
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0) return null;
  const colorIndex = (sourceIndex + 1) % BINDING_ROUTE_COLOR_COUNT;
  return {
    number: sourceIndex + 1,
    color: `var(--depth-${colorIndex})`,
    background: `var(--depth-${colorIndex}-bg)`,
  };
}

export function workflowStepBindingMarkers(levels, depth, stepId) {
  if (!Array.isArray(levels)) return { incoming: null, outgoing: null };
  const level = levels.find((candidate) => candidate.depth === depth);
  const step = level?.steps?.find((candidate) => candidate.id === stepId);
  if (!level || !step) return { incoming: null, outgoing: null };

  let incoming = null;
  if (level.bindPrevious && step.boundSourceStepId) {
    const previous = levels.find((candidate) => candidate.depth === depth - 1);
    const sourceIndex = previous?.steps?.findIndex((candidate) => candidate.id === step.boundSourceStepId) ?? -1;
    if (sourceIndex >= 0) {
      incoming = {
        ...workflowBindingRouteToken(sourceIndex),
        peer: previous.steps[sourceIndex],
      };
    }
  }

  let outgoing = null;
  const destination = levels.find((candidate) => candidate.depth === depth + 1);
  if (destination?.bindPrevious) {
    const destinationStep = destination.steps.find((candidate) => candidate.boundSourceStepId === step.id);
    const sourceIndex = level.steps.findIndex((candidate) => candidate.id === step.id);
    if (destinationStep && sourceIndex >= 0) {
      outgoing = {
        ...workflowBindingRouteToken(sourceIndex),
        peer: destinationStep,
      };
    }
  }

  return { incoming, outgoing };
}

export function setWorkflowDepthBinding(builder, sourceDepth, enabled) {
  if (!builder || !Array.isArray(builder.levels)) throw new TypeError('A workflow builder is required.');
  const next = JSON.parse(JSON.stringify(builder));
  const source = next.levels.find((level) => level.depth === sourceDepth);
  const destination = next.levels.find((level) => level.depth === sourceDepth + 1);
  if (!source || !destination) throw new RangeError('Choose a depth that has a following depth.');

  if (!enabled) {
    destination.bindPrevious = false;
    destination.steps.forEach((step) => (step.boundSourceStepId = null));
    return next;
  }
  if (source.steps.length !== destination.steps.length) {
    throw new RangeError('Bind routing requires the two depths to have the same number of steps.');
  }
  if (source.steps.length < 2) {
    throw new RangeError('Bind routing requires at least two steps in both depths.');
  }
  destination.bindPrevious = true;
  destination.consumesAll = false;
  destination.steps.forEach((step, index) => (step.boundSourceStepId = source.steps[index].id));
  return next;
}

export function setWorkflowStepBinding(builder, destinationDepth, destinationStepId, sourceStepId) {
  if (!builder || !Array.isArray(builder.levels)) throw new TypeError('A workflow builder is required.');
  const next = JSON.parse(JSON.stringify(builder));
  const source = next.levels.find((level) => level.depth === destinationDepth - 1);
  const destination = next.levels.find((level) => level.depth === destinationDepth);
  if (!source || !destination?.bindPrevious) throw new RangeError('Enable bind routing for this transition first.');
  if (!source.steps.some((step) => step.id === sourceStepId)) {
    throw new RangeError('Choose a source step from the immediately previous depth.');
  }
  const selected = destination.steps.find((step) => step.id === destinationStepId);
  if (!selected) throw new RangeError('Choose an existing destination step.');

  const oldSourceId = selected.boundSourceStepId;
  const occupied = destination.steps.find(
    (step) => step.id !== destinationStepId && step.boundSourceStepId === sourceStepId
  );
  selected.boundSourceStepId = sourceStepId;
  if (occupied) occupied.boundSourceStepId = oldSourceId;
  return next;
}

export function workflowNeedsDuplicate(error) {
  return error instanceof ApiError && error.status === 409 && error.code === 'workflow_in_use';
}

export function workflowDuplicatePrompt(error) {
  const scanCount = error?.data?.scanCount;
  const usage = Number.isInteger(scanCount)
    ? `it is used by ${scanCount} ${scanCount === 1 ? 'scan' : 'scans'}`
    : 'it is already used in scans';
  return `This workflow cannot be edited because ${usage}.\n\nSave a duplicate with your changes instead?`;
}

export async function saveWorkflowDraft({ id, payload, updateWorkflow, createWorkflow, confirmDuplicate }) {
  if (!id) return createWorkflow(payload);

  try {
    return await updateWorkflow(id, payload);
  } catch (error) {
    if (!workflowNeedsDuplicate(error)) throw error;
    if (!(await confirmDuplicate(workflowDuplicatePrompt(error)))) return null;
    return createWorkflow(payload);
  }
}

const BATCH_DEPTH_REFERENCE = /(\{\{\s*)multi_output_depth_(\d+)(\s*\}\})/g;

function shiftBatchDepthReferences(content, depthMap) {
  if (typeof content !== 'string' || depthMap.size === 0) return content;
  return content.replace(BATCH_DEPTH_REFERENCE, (reference, opening, rawDepth, closing) => {
    const nextDepth = depthMap.get(Number(rawDepth));
    return nextDepth === undefined ? reference : `${opening}${multiOutputDepthKey(nextDepth)}${closing}`;
  });
}

/**
 * Insert a blank workflow level immediately before an existing depth. Existing
 * levels at and below that point move down together. Batch variables contain
 * their source depth in the key, so valid references to moved batch boundaries
 * are renumbered at the same time.
 */
export function insertWorkflowDepthBefore(builder, depth, newStepId) {
  if (!builder || !Array.isArray(builder.levels)) throw new TypeError('A workflow builder is required.');
  if (!Number.isInteger(depth) || !builder.levels.some((level) => level.depth === depth)) {
    throw new RangeError('Choose an existing workflow depth.');
  }
  if (!newStepId) throw new TypeError('A new step id is required.');

  const next = JSON.parse(JSON.stringify(builder));
  const batchDepthMap = new Map(
    next.levels
      .filter((level) => level.depth > 0 && level.consumesAll && level.depth >= depth)
      .map((level) => [level.depth - 1, level.depth])
  );

  next.levels.forEach((level) => {
    level.steps.forEach((step) => {
      step.content = shiftBatchDepthReferences(step.content, batchDepthMap);
    });
    if (level.depth >= depth) level.depth += 1;
  });
  next.levels.push({
    depth,
    multiOutput: true,
    consumesAll: false,
    bindPrevious: false,
    schema: [],
    steps: [{ id: newStepId, name: 'New step', content: '', boundSourceStepId: null }],
  });
  next.levels.sort((left, right) => left.depth - right.depth);
  next.selStepId = newStepId;
  return next;
}

/**
 * Remove one step. If it was the depth's final sibling, remove that depth and
 * close the gap by shifting every later depth down. Batch variables encode the
 * source depth in their name, so surviving batching boundaries move with their
 * levels. References to ordinary output keys from the deleted depth remain
 * untouched and are intentionally surfaced as invalid by the editor.
 */
export function removeWorkflowStep(builder, stepId) {
  if (!builder || !Array.isArray(builder.levels)) throw new TypeError('A workflow builder is required.');

  const next = JSON.parse(JSON.stringify(builder));
  const level = next.levels.find((candidate) => candidate.steps.some((step) => step.id === stepId));
  if (!level) return next;

  const stepCount = next.levels.reduce((count, candidate) => count + candidate.steps.length, 0);
  if (stepCount <= 1) return next;

  const removedDepth = level.depth;
  const removesDepth = level.steps.length === 1;
  level.steps = level.steps.filter((step) => step.id !== stepId);

  if (removesDepth) {
    const batchDepthMap = new Map(
      next.levels
        .filter(
          (candidate) =>
            candidate !== level && candidate.depth > removedDepth && candidate.depth > 1 && candidate.consumesAll
        )
        .map((candidate) => [candidate.depth - 1, candidate.depth - 2])
    );

    next.levels = next.levels.filter((candidate) => candidate !== level);
    next.levels.forEach((candidate) => {
      candidate.steps.forEach((step) => {
        step.content = shiftBatchDepthReferences(step.content, batchDepthMap);
      });
      if (candidate.depth > removedDepth) candidate.depth -= 1;
      // Deleting depth 0 promotes the old depth 1 to the root. Root steps have
      // no upstream result set and therefore cannot consume all previous work.
      if (candidate.depth === 0) candidate.consumesAll = false;
      if (candidate.depth === 0) {
        candidate.bindPrevious = false;
        candidate.steps.forEach((step) => (step.boundSourceStepId = null));
      }
    });
    next.levels.sort((left, right) => left.depth - right.depth);
  }

  clearInvalidWorkflowBindings(next.levels);
  if (!next.levels.some((candidate) => candidate.depth === 2)) next.dedupeStep3 = false;

  const selectedStillExists = next.levels.some((candidate) =>
    candidate.steps.some((step) => step.id === next.selStepId)
  );
  if (!selectedStillExists) {
    const fallbackDepth = Math.min(removedDepth, next.levels[next.levels.length - 1].depth);
    const fallbackLevel = next.levels.find((candidate) => candidate.depth === fallbackDepth) || next.levels[0];
    next.selStepId = fallbackLevel.steps[0].id;
  }

  return next;
}

export function builderFromWorkflow(wf, { copy = false, selectedStepId = null } = {}) {
  const localIds = new Map(wf.steps.map((step) => [step.id, copy ? uid() : step.id]));
  const depths = [...new Set(wf.steps.map((s) => s.depth))].sort((a, b) => a - b);
  const levels = depths.map((depth) => {
    const steps = wf.steps.filter((s) => s.depth === depth);
    return {
      depth,
      multiOutput: steps[0].multiOutput,
      consumesAll: !!steps[0].consumesAll,
      bindPrevious: steps.some((step) => step.boundSourceStepId != null),
      schema: objectToRows(steps[0].outputFormat),
      // When duplicating into a brand-new workflow, give steps fresh local ids
      // so nothing is tied back to the source's DB rows.
      steps: steps.map((s) => ({
        id: localIds.get(s.id),
        name: s.name || '',
        content: s.content,
        boundSourceStepId: s.boundSourceStepId ? localIds.get(s.boundSourceStepId) || null : null,
      })),
    };
  });
  const name = copy ? `copy-of-${wf.name}` : wf.name;
  const requestedStepExists =
    !copy && selectedStepId && levels.some((level) => level.steps.some((step) => step.id === selectedStepId));
  return {
    name,
    description: wf.description || '',
    extra: Array.isArray(wf.extra) ? wf.extra : [],
    includeContextFiles: wf.includeContextFiles === true,
    dedupeStep3: wf.dedupeStep3 === true,
    schemaMode: 'visual',
    selStepId: requestedStepExists ? selectedStepId : levels[0].steps[0].id,
    levels,
  };
}

export default function WorkflowBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const fromId = id ? null : params.get('from'); // duplicate source (new route only)
  const generationId = id || fromId ? null : params.get('generation');
  const selectedStepId = id ? params.get('step') : null;
  const editorRef = useRef(null);

  const [b, setB] = useState(id || fromId || generationId ? null : blankBuilder());
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState([]);
  const [duplicatePrompt, setDuplicatePrompt] = useState(null);
  const duplicateConfirmationRef = useRef(null);
  const initialRef = useRef(b ? workflowSnapshot(b) : null);

  usePageChrome(
    [
      { label: 'Workflows', to: '/workflows' },
      { label: id ? 'Edit workflow' : 'New workflow', active: true },
    ],
    null,
    [id]
  );

  useEffect(() => {
    let active = true;
    duplicateConfirmationRef.current?.(false);
    duplicateConfirmationRef.current = null;
    initialRef.current = null;
    setLoadError(null);
    setServerErrors([]);
    setSaving(false);
    setDuplicatePrompt(null);
    setB(null);
    if (generationId) {
      api
        .generation(generationId)
        .then((job) => {
          if (!active) return;
          const result = resultFromCompletedGeneration(job, 'workflow');
          const next = workflowBuilderFromGeneration(result, uid);
          initialRef.current = workflowSnapshot(next);
          setB(next);
        })
        .catch((error) => active && setLoadError(error));
      return () => {
        active = false;
      };
    }
    const sourceId = id || fromId;
    if (!sourceId) {
      const next = blankBuilder();
      initialRef.current = workflowSnapshot(next);
      setB(next);
      return () => {
        active = false;
      };
    }
    api
      .workflow(sourceId)
      .then((wf) => {
        if (!active) return;
        const next = builderFromWorkflow(wf, { copy: !id, selectedStepId });
        initialRef.current = workflowSnapshot(next);
        setB(next);
      })
      .catch((error) => active && setLoadError(error));
    return () => {
      active = false;
    };
  }, [generationId, id, fromId, selectedStepId]);

  useEffect(
    () => () => {
      duplicateConfirmationRef.current?.(false);
      duplicateConfirmationRef.current = null;
    },
    []
  );

  // Track unsaved changes by comparing the meaningful builder state (name,
  // description, levels) against the initial snapshot — ignoring UI-only state
  // like which step is selected. Hooks must run before any early return.
  const dirty = workflowDraftIsDirty(b, initialRef.current, Boolean(generationId || fromId));
  const { allow } = useUnsavedChangesPrompt(dirty || saving);

  if (loadError)
    return (
      <div style={{ padding: 26 }}>
        <ErrorState error={loadError} onRetry={() => window.location.reload()} />
      </div>
    );
  if (!b)
    return (
      <div style={{ padding: 26 }}>
        <Spinner />
      </div>
    );

  const mut = (fn) => {
    const next = JSON.parse(JSON.stringify(b));
    fn(next);
    setB(next);
  };

  // ---- derived ----
  const maxDepth = Math.max(...b.levels.map((l) => l.depth));
  const globalKeyCount = {};
  b.levels.forEach((l) => l.schema.forEach((f) => f.key && (globalKeyCount[f.key] = (globalKeyCount[f.key] || 0) + 1)));

  const levelAt = (d) => b.levels.find((l) => l.depth === d);
  // Any depth after the root can batch: even a single-step depth produces one
  // answer per upstream output, so the level below it sees multiple results.
  // Effective batching: whenever the user opted in on a non-root depth.
  const levelConsumesAll = (level) => !!level.consumesAll && level.depth > 0;

  const earlierKeys = (depth) => {
    const map = new Map();
    BUILTIN_KEYS.forEach((k) => map.set(k, 'built-in'));
    b.levels
      .filter((l) => l.depth < depth)
      .sort((left, right) => left.depth - right.depth)
      .forEach((l) => {
        const consumer = levelAt(l.depth + 1);
        if (consumer && levelConsumesAll(consumer)) {
          for (const key of map.keys()) {
            if (!BUILTIN_KEYS.includes(key) && !isMultiOutputDepthKey(key)) map.delete(key);
          }
          map.set(multiOutputDepthKey(l.depth), `batch d${l.depth}`);
        } else l.schema.forEach((f) => f.key && map.set(f.key, `d${l.depth}`));
      });
    return map;
  };
  const fieldError = (f) => {
    if (!f.key) return true;
    if (!isValidKey(f.key)) return true;
    if (!FIELD_TYPES.includes(f.type)) return true;
    if (BUILTIN_KEYS.includes(f.key) || f.key === EXTRA_KEY || isMultiOutputDepthKey(f.key)) return true;
    if (globalKeyCount[f.key] > 1) return true;
    return false;
  };
  const stepValid = (level, step) => {
    const avail = earlierKeys(level.depth);
    const { refs, malformed } = parseTemplateRefs(step.content);
    return !!step.content.trim() && malformed.length === 0 && refs.every((k) => refResolves(k, avail, true));
  };
  const levelSchemaValid = (l) => l.schema.length > 0 && l.schema.every((f) => !fieldError(f));
  const lastMissing = () => {
    const last = b.levels.find((l) => l.depth === maxDepth);
    const have = new Set(last.schema.map((f) => f.key));
    return REQUIRED_VULN_KEYS.filter((k) => !have.has(k));
  };
  const lastInvalidTypes = () => {
    const last = b.levels.find((l) => l.depth === maxDepth);
    const actualTypes = new Map(last.schema.map((field) => [field.key, field.type]));
    return [...REQUIRED_VULN_KEYS, ...OPTIONAL_VULN_KEYS]
      .filter((key) => actualTypes.has(key) && actualTypes.get(key) !== REQUIRED_KEY_TYPES[key])
      .map((key) => ({ key, expected: REQUIRED_KEY_TYPES[key], actual: actualTypes.get(key) }));
  };

  // ---- actions ----
  const addSibling = (depth) =>
    mut((n) => {
      const id2 = uid();
      n.levels
        .find((l) => l.depth === depth)
        .steps.push({ id: id2, name: 'New sibling step', content: '', boundSourceStepId: null });
      n.selStepId = id2;
    });
  const addLevel = () =>
    mut((n) => {
      const id2 = uid();
      const nd = Math.max(...n.levels.map((l) => l.depth)) + 1;
      n.levels.push({
        depth: nd,
        multiOutput: true,
        consumesAll: false,
        bindPrevious: false,
        schema: [],
        steps: [{ id: id2, name: 'New step', content: '', boundSourceStepId: null }],
      });
      n.selStepId = id2;
    });
  const insertLevelBefore = (depth) => {
    const id2 = uid();
    setB((current) => insertWorkflowDepthBefore(current, depth, id2));
  };
  const setConsumesAll = (depth, val) =>
    mut((n) => {
      const l = n.levels.find((x) => x.depth === depth);
      l.consumesAll = val;
      if (val) {
        l.bindPrevious = false;
        l.steps.forEach((step) => (step.boundSourceStepId = null));
      }
    });
  const setDepthBinding = (sourceDepth, enabled) =>
    setB((current) => setWorkflowDepthBinding(current, sourceDepth, enabled));
  const setStepBinding = (destinationDepth, destinationStepId, sourceStepId) =>
    setB((current) => setWorkflowStepBinding(current, destinationDepth, destinationStepId, sourceStepId));
  const removeStep = (sid) => setB((current) => removeWorkflowStep(current, sid));
  const toggleMulti = (depth) =>
    mut((n) => {
      const l = n.levels.find((x) => x.depth === depth);
      l.multiOutput = !l.multiOutput;
    });
  const setSchema = (depth, rows) =>
    mut((n) => {
      n.levels.find((l) => l.depth === depth).schema = rows;
    });
  const addRequired = (depth) =>
    mut((n) => {
      const l = n.levels.find((x) => x.depth === depth);
      REQUIRED_VULN_KEYS.forEach((k) => {
        const existing = l.schema.find((field) => field.key === k);
        if (existing) existing.type = REQUIRED_KEY_TYPES[k] || 'string';
        else l.schema.push({ key: k, type: REQUIRED_KEY_TYPES[k] || 'string' });
      });
      OPTIONAL_VULN_KEYS.forEach((k) => {
        const existing = l.schema.find((field) => field.key === k);
        if (existing) existing.type = REQUIRED_KEY_TYPES[k] || 'string';
      });
    });

  // selected step + its level
  let sel = null;
  let selLevel = null;
  b.levels.forEach((l) =>
    l.steps.forEach((s) => {
      if (s.id === b.selStepId) {
        sel = s;
        selLevel = l;
      }
    })
  );

  // ---- global validation ----
  const errors = [];
  b.levels.forEach((l) => {
    if (!levelSchemaValid(l)) errors.push(`Depth ${l.depth}: fix output schema`);
    l.steps.forEach((s) => {
      if (!s.content.trim()) errors.push(`${s.name || 'Step'}: prompt content is required`);
      else if (!stepValid(l, s)) errors.push(`${s.name || 'Step'}: invalid template key reference`);
    });
  });
  errors.push(...workflowBindingErrors(b.levels));
  const orderedDepths = [...b.levels].map((level) => level.depth).sort((left, right) => left - right);
  if (orderedDepths.some((depth, index) => depth !== index)) errors.push('Workflow depths must be contiguous from 0');
  const miss = lastMissing();
  const invalidTypes = lastInvalidTypes();
  if (miss.length) errors.push(`Final step missing ${miss.length} required key${miss.length > 1 ? 's' : ''}`);
  if (invalidTypes.length)
    errors.push(
      `Final step has ${invalidTypes.length} vulnerability key type mismatch${invalidTypes.length > 1 ? 'es' : ''}`
    );
  if (!b.name.trim()) errors.push('Name your workflow');
  const canSave = errors.length === 0 && !saving;

  const requestDuplicateConfirmation = (message) => {
    setSaving(false);
    setDuplicatePrompt(message);
    return new Promise((resolve) => {
      duplicateConfirmationRef.current = resolve;
    });
  };

  const answerDuplicateConfirmation = (confirmed) => {
    if (saving) return;
    const resolve = duplicateConfirmationRef.current;
    if (!resolve) return;
    duplicateConfirmationRef.current = null;
    if (confirmed) setSaving(true);
    else setDuplicatePrompt(null);
    resolve(confirmed);
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setServerErrors([]);
    const payload = {
      name: b.name.trim(),
      description: b.description,
      extra: b.includeContextFiles === true ? b.extra : [],
      includeContextFiles: b.includeContextFiles === true,
      dedupeStep3: b.dedupeStep3 === true,
      levels: b.levels.map((l) => ({
        depth: l.depth,
        multiOutput: l.multiOutput,
        consumesAll: !!l.consumesAll, // raw opt-in; backend computes the effective value
        bindPrevious: !!l.bindPrevious,
        outputFormat: rowsToObject(l.schema.filter((f) => f.key)),
        steps: l.steps.map((s) => ({
          clientId: s.id,
          name: s.name,
          content: s.content,
          boundSourceStepId: l.bindPrevious ? s.boundSourceStepId || null : null,
        })),
      })),
    };
    try {
      const wf = await saveWorkflowDraft({
        id,
        payload,
        updateWorkflow: api.updateWorkflow,
        createWorkflow: api.createWorkflow,
        confirmDuplicate: requestDuplicateConfirmation,
      });
      if (!wf) {
        setDuplicatePrompt(null);
        setSaving(false);
        return;
      }
      allow(); // intentional navigation — don't prompt about unsaved changes
      navigate(`/workflows/${wf.id}`);
    } catch (e) {
      setDuplicatePrompt(null);
      if (e instanceof ApiError) setServerErrors(apiErrorMessages(e, { includeField: false }));
      else setServerErrors([e.message]);
      setSaving(false);
    }
  };

  const sortedLevels = [...b.levels].sort((a, c) => a.depth - c.depth);

  return (
    <div
      className="workflow-builder"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div className="workflow-builder-body" style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* LEFT: meta + editable tree */}
        <div
          className="workflow-builder-tree"
          style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '26px 30px' }}
        >
          <input
            value={b.name}
            onChange={(e) => mut((n) => (n.name = e.target.value))}
            spellCheck={false}
            placeholder="workflow-name"
            className="mono"
            style={{
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: 23,
              fontWeight: 600,
              color: 'var(--text)',
              letterSpacing: 0,
              width: '100%',
              padding: 0,
            }}
          />
          <input
            value={b.description}
            onChange={(e) => mut((n) => (n.description = e.target.value))}
            placeholder="Describe what this workflow looks for…"
            style={{
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: 13.5,
              color: 'var(--text-2)',
              width: '100%',
              marginTop: 6,
              padding: 0,
            }}
          />

          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 9,
              marginTop: 16,
              padding: '10px 12px',
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--surface)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={b.includeContextFiles === true}
              onChange={(event) => mut((next) => (next.includeContextFiles = event.target.checked))}
              style={{ marginTop: 2 }}
            />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <strong style={{ fontSize: 12.5, color: 'var(--text)' }}>Attach extra inputs to workspace</strong>
              <span style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-3)' }}>
                Adds configuration and extra inputs as files, then tells each step to inspect only the relevant parts.
              </span>
            </span>
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 9,
              marginTop: 10,
              padding: '10px 12px',
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--surface)',
              cursor: maxDepth >= 2 ? 'pointer' : 'not-allowed',
              opacity: maxDepth >= 2 ? 1 : 0.55,
            }}
          >
            <input
              type="checkbox"
              checked={b.dedupeStep3 === true}
              disabled={maxDepth < 2}
              onChange={(event) => mut((next) => (next.dedupeStep3 = event.target.checked))}
              style={{ marginTop: 2 }}
            />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <strong style={{ fontSize: 12.5, color: 'var(--text)' }}>Deduplicate candidates before step 3</strong>
              <span style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-3)' }}>
                Runs a conservative tool-free Codex comparison before each depth-2 workspace is built. Uncertain
                candidates continue normally.
              </span>
            </span>
          </label>

          {generationId && (
            <div
              style={{
                marginTop: 18,
                padding: '10px 12px',
                border: '1px solid var(--run-bg)',
                borderRadius: 8,
                background: 'var(--run-bg)',
                color: 'var(--run)',
                fontSize: 12.5,
                lineHeight: 1.5,
              }}
            >
              AI-generated draft. Review the steps, prompts, variables, and output schemas before saving.
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 28 }}>
            {sortedLevels.map((level, i) => {
              const fanLabel =
                level.steps.length > 1
                  ? `· ${level.steps.length} siblings · shared schema`
                  : level.multiOutput
                    ? '· multi-output ⤳'
                    : '';
              return (
                <div
                  key={level.depth}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}
                >
                  <div
                    className="workflow-builder-level-heading"
                    style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 11 }}
                  >
                    <span
                      className="mono"
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        border: '1px solid var(--border)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 10,
                        color: 'var(--text-2)',
                      }}
                    >
                      {level.depth}
                    </span>
                    <span className="mono" style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--text-3)' }}>
                      DEPTH {level.depth} {fanLabel}
                    </span>
                    {levelConsumesAll(level) && (
                      <span
                        className="mono"
                        style={{
                          fontSize: 9.5,
                          color: 'var(--run)',
                          background: 'var(--run-bg)',
                          borderRadius: 5,
                          padding: '2px 7px',
                          letterSpacing: '0.04em',
                        }}
                      >
                        batched
                      </span>
                    )}
                    {level.bindPrevious && (
                      <span
                        className="mono"
                        style={{
                          fontSize: 9.5,
                          color: 'var(--accent)',
                          background: 'var(--accent-subtle)',
                          borderRadius: 5,
                          padding: '2px 7px',
                          letterSpacing: '0.04em',
                        }}
                      >
                        bound 1:1
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => insertLevelBefore(level.depth)}
                      className="mono"
                      title={`Insert a new step at depth ${level.depth} and shift this depth and everything below it down`}
                      style={{
                        fontSize: 10,
                        color: 'var(--text-2)',
                        cursor: 'pointer',
                        border: '1px dashed var(--border)',
                        borderRadius: 5,
                        padding: '1px 6px',
                        background: 'transparent',
                      }}
                    >
                      + insert before
                    </button>
                    <span
                      onClick={() => addSibling(level.depth)}
                      className="mono"
                      style={{
                        fontSize: 10,
                        color: 'var(--accent)',
                        cursor: 'pointer',
                        border: '1px dashed var(--accent)',
                        borderRadius: 5,
                        padding: '1px 6px',
                      }}
                    >
                      + sibling
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap' }}>
                    {level.steps.map((step) => {
                      const valid = stepValid(level, step);
                      const selected = b.selStepId === step.id;
                      const bindingMarkers = workflowStepBindingMarkers(b.levels, level.depth, step.id);
                      const primaryBindingMarker = bindingMarkers.incoming || bindingMarkers.outgoing;
                      return (
                        <div
                          key={step.id}
                          onClick={() => mut((n) => (n.selStepId = step.id))}
                          style={{
                            width: 268,
                            position: 'relative',
                            border: `${valid ? 1.5 : 2}px solid ${
                              valid
                                ? primaryBindingMarker
                                  ? primaryBindingMarker.color
                                  : selected
                                    ? 'var(--accent)'
                                    : 'var(--border)'
                                : 'var(--fail)'
                            }`,
                            borderRadius: 11,
                            background:
                              valid && primaryBindingMarker
                                ? `color-mix(in srgb, ${primaryBindingMarker.background} 45%, var(--surface))`
                                : valid
                                  ? 'var(--surface)'
                                  : 'var(--fail-bg)',
                            boxShadow: valid
                              ? selected && primaryBindingMarker
                                ? '0 0 0 2px var(--accent-subtle), var(--shadow)'
                                : 'var(--shadow)'
                              : `0 0 0 2px ${selected ? 'var(--accent)' : 'transparent'}`,
                            cursor: 'pointer',
                            overflow: 'hidden',
                          }}
                        >
                          {bindingMarkers.incoming && (
                            <div
                              aria-hidden="true"
                              style={{
                                position: 'absolute',
                                inset: '0 0 auto',
                                height: 4,
                                background: bindingMarkers.incoming.color,
                                zIndex: 2,
                              }}
                            />
                          )}
                          {bindingMarkers.outgoing && (
                            <div
                              aria-hidden="true"
                              style={{
                                position: 'absolute',
                                inset: 'auto 0 0',
                                height: 4,
                                background: bindingMarkers.outgoing.color,
                                zIndex: 2,
                              }}
                            />
                          )}
                          {!valid && (
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                padding: '5px 14px',
                                background: 'var(--fail)',
                                color: '#fff',
                                fontSize: 10.5,
                                fontWeight: 600,
                                letterSpacing: '0.02em',
                              }}
                            >
                              <span style={{ fontSize: 11, lineHeight: 1 }}>⚠</span>
                              <span>INVALID - template key reference</span>
                            </div>
                          )}
                          <div style={{ padding: '12px 14px' }}>
                            <div
                              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                                <span
                                  style={{
                                    width: 7,
                                    height: 7,
                                    borderRadius: '50%',
                                    flex: 'none',
                                    background: valid ? 'var(--ok)' : 'var(--fail)',
                                  }}
                                />
                                <span
                                  style={{
                                    fontWeight: 600,
                                    fontSize: 13.5,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    color: valid ? 'var(--text)' : 'var(--fail)',
                                  }}
                                >
                                  {step.name || 'Untitled step'}
                                </span>
                              </div>
                              {(b.levels.length > 1 || level.steps.length > 1) && (
                                <span
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeStep(step.id);
                                  }}
                                  style={{ color: 'var(--text-3)', fontSize: 15, lineHeight: 1, flex: 'none' }}
                                >
                                  ×
                                </span>
                              )}
                            </div>
                            <div
                              style={{
                                fontSize: 11.5,
                                color: 'var(--text-3)',
                                marginTop: 6,
                                height: 32,
                                overflow: 'hidden',
                                lineHeight: 1.45,
                              }}
                            >
                              {(step.content || 'No prompt yet').replace(/\{\{\s*|\s*\}\}/g, '').slice(0, 80)}
                            </div>
                            {(bindingMarkers.incoming || bindingMarkers.outgoing) && (
                              <div
                                style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  alignItems: 'flex-start',
                                  gap: 5,
                                  marginTop: 7,
                                }}
                              >
                                {bindingMarkers.incoming && (
                                  <BindingRouteBadge marker={bindingMarkers.incoming} direction="incoming" />
                                )}
                                {bindingMarkers.outgoing && (
                                  <BindingRouteBadge marker={bindingMarkers.outgoing} direction="outgoing" />
                                )}
                              </div>
                            )}
                            <div className="mono" style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 8 }}>
                              {level.schema.filter((f) => f.key).length} keys
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {i < sortedLevels.length - 1 && (
                    <div style={{ width: 1.5, height: 30, background: 'var(--border)' }} />
                  )}
                </div>
              );
            })}
            <div
              onClick={addLevel}
              className="mono"
              style={{
                marginTop: 18,
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                height: 34,
                padding: '0 16px',
                border: '1px dashed var(--border)',
                borderRadius: 9,
                fontSize: 12.5,
                color: 'var(--text-2)',
                cursor: 'pointer',
              }}
            >
              + add depth level
            </div>
          </div>
        </div>

        {/* RIGHT: step editor */}
        {sel && selLevel && (
          <div
            className="workflow-builder-step-panel"
            style={{
              width: 480,
              flex: 'none',
              borderLeft: '1px solid var(--border)',
              background: 'var(--surface)',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }}
          >
            <div style={{ flex: 'none', borderBottom: '1px solid var(--border)', padding: '14px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    color: 'var(--text-3)',
                    border: '1px solid var(--border)',
                    padding: '2px 6px',
                    borderRadius: 5,
                  }}
                >
                  DEPTH {selLevel.depth}
                </span>
                {selLevel.depth === maxDepth && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 10,
                      color: 'var(--accent)',
                      background: 'var(--accent-subtle)',
                      padding: '2px 6px',
                      borderRadius: 5,
                    }}
                  >
                    TERMINAL → vulnerabilities
                  </span>
                )}
              </div>
              <input
                value={sel.name}
                onChange={(e) =>
                  mut((n) =>
                    n.levels.forEach((l) =>
                      l.steps.forEach((s) => {
                        if (s.id === sel.id) s.name = e.target.value;
                      })
                    )
                  )
                }
                placeholder="Step name"
                style={{
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  fontSize: 16,
                  fontWeight: 600,
                  color: 'var(--text)',
                  width: '100%',
                  padding: 0,
                }}
              />
            </div>

            <div className="workflow-builder-step-body" style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
              {selLevel.depth > 0 && (
                <ConsumeToggle
                  depth={selLevel.depth}
                  batched={levelConsumesAll(selLevel)}
                  onOne={() => setConsumesAll(selLevel.depth, false)}
                  onAll={() => setConsumesAll(selLevel.depth, true)}
                />
              )}
              {selLevel.bindPrevious && (
                <div
                  style={{
                    margin: '-8px 0 20px',
                    padding: '8px 11px',
                    borderRadius: 7,
                    color: 'var(--accent)',
                    background: 'var(--accent-subtle)',
                    fontSize: 11.5,
                    lineHeight: 1.45,
                  }}
                >
                  This step receives results only from{' '}
                  <span className="mono">
                    {levelAt(selLevel.depth - 1)?.steps.find((candidate) => candidate.id === sel.boundSourceStepId)
                      ?.name || 'its bound source'}
                  </span>
                  .
                </div>
              )}
              {workflowCanShowBindRouting(selLevel, levelAt(selLevel.depth + 1)) && (
                <BindRouting
                  sourceLevel={selLevel}
                  destinationLevel={levelAt(selLevel.depth + 1)}
                  onToggle={(enabled) => setDepthBinding(selLevel.depth, enabled)}
                  onChange={(destinationStepId, sourceStepId) =>
                    setStepBinding(selLevel.depth + 1, destinationStepId, sourceStepId)
                  }
                />
              )}
              <Label>PROMPT CONTENT</Label>
              <PromptEditor
                ref={editorRef}
                value={sel.content}
                onChange={(e) =>
                  mut((n) =>
                    n.levels.forEach((l) =>
                      l.steps.forEach((s) => {
                        if (s.id === sel.id) s.content = e.target.value;
                      })
                    )
                  )
                }
                available={earlierKeys(selLevel.depth)}
                allowExtra
                expandable
                title={`${sel.name || 'Step'} · prompt`}
                paletteChips={[
                  ...[...earlierKeys(selLevel.depth).entries()].map(([name, from]) => ({
                    label: `${name} · ${from}`,
                    token: name,
                  })),
                  { label: 'extra.<key> · dynamic', token: 'extra.', accent: true },
                ]}
              />

              <RefSummary content={sel.content} available={earlierKeys(selLevel.depth)} />

              <Label style={{ margin: '18px 0 8px' }}>
                AVAILABLE KEYS <span style={{ textTransform: 'none', letterSpacing: 0 }}>· click to insert</span>
              </Label>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {[...earlierKeys(selLevel.depth).entries()].map(([name, from]) => (
                  <span
                    key={name}
                    onClick={() => editorRef.current?.insert(name)}
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      padding: '3px 8px',
                      borderRadius: 6,
                      color: 'var(--text-2)',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border-2)',
                      cursor: 'pointer',
                    }}
                  >
                    {name}
                    <span style={{ color: 'var(--text-3)' }}> · {from}</span>
                  </span>
                ))}
                {/* Dynamic extra context — inserts {{extra.}} for you to name the sub-key. */}
                <span
                  onClick={() => editorRef.current?.insert('extra.')}
                  className="mono"
                  style={{
                    fontSize: 10.5,
                    padding: '3px 8px',
                    borderRadius: 6,
                    color: 'var(--accent)',
                    background: 'var(--accent-subtle)',
                    border: '1px solid var(--accent-subtle)',
                    cursor: 'pointer',
                  }}
                >
                  extra.&lt;key&gt;<span style={{ color: 'var(--text-3)' }}> · dynamic</span>
                </span>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  margin: '22px 0 10px',
                }}
              >
                <Label inline>OUTPUT FORMAT</Label>
                <Toggle on={selLevel.multiOutput} onClick={() => toggleMulti(selLevel.depth)} label="multi_output" />
              </div>
              {selLevel.steps.length > 1 && (
                <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 10 }}>
                  Shared across {selLevel.steps.length} sibling steps
                </div>
              )}
              <SchemaEditor
                rows={selLevel.schema}
                onRowsChange={(rows) => setSchema(selLevel.depth, rows)}
                mode={b.schemaMode}
                onToggleMode={() => mut((n) => (n.schemaMode = n.schemaMode === 'visual' ? 'raw' : 'visual'))}
                validateKey={(key) =>
                  !isValidKey(key)
                    ? 'invalid key name'
                    : BUILTIN_KEYS.includes(key) || key === EXTRA_KEY || isMultiOutputDepthKey(key)
                      ? 'reserved key'
                      : globalKeyCount[key] > 1
                        ? 'key already used in another step'
                        : null
                }
                inputBg="var(--bg)"
                types={FIELD_TYPES}
              />

              {selLevel.depth === maxDepth && (
                <LastStepBox missing={miss} invalidTypes={invalidTypes} onAddAll={() => addRequired(selLevel.depth)} />
              )}
            </div>
          </div>
        )}
      </div>

      {/* footer */}
      <div
        className="workflow-builder-footer"
        style={{
          flex: 'none',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg)',
          padding: '13px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div
          className="workflow-builder-footer-status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 12.5,
            color: 'var(--text-2)',
            minWidth: 0,
          }}
        >
          {errors.length === 0 && serverErrors.length === 0 ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--ok)' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok)' }} />
              Workflow is valid and ready to save.
            </span>
          ) : (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--fail)', flex: 'none' }} />
              <span
                style={{ color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
              >
                {(serverErrors.length ? serverErrors : errors).slice(0, 3).join(' · ')}
              </span>
            </span>
          )}
        </div>
        <button
          type="button"
          disabled={!canSave}
          onClick={save}
          className="workflow-builder-save"
          style={{
            border: 0,
            height: 36,
            padding: '0 18px',
            display: 'flex',
            alignItems: 'center',
            borderRadius: 9,
            fontSize: 13.5,
            fontWeight: 500,
            cursor: canSave ? 'pointer' : 'default',
            background: canSave ? 'var(--accent)' : 'var(--surface-2)',
            color: canSave ? 'var(--accent-fg)' : 'var(--text-3)',
            flex: 'none',
          }}
        >
          {saving
            ? 'Saving…'
            : errors.length === 0
              ? id
                ? 'Save changes'
                : 'Save workflow'
              : `${errors.length} issue${errors.length > 1 ? 's' : ''} to fix`}
        </button>
      </div>

      {duplicatePrompt && (
        <WorkflowDuplicateDialog
          message={duplicatePrompt}
          saving={saving}
          onConfirm={() => answerDuplicateConfirmation(true)}
          onCancel={() => answerDuplicateConfirmation(false)}
        />
      )}
    </div>
  );
}

export function WorkflowDuplicateDialog({ message, saving, onConfirm, onCancel }) {
  const closeDialog = () => {
    if (!saving) onCancel();
  };
  const dialogRef = useModalDialog(closeDialog);

  return (
    <div
      onClick={closeDialog}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        background: 'rgba(0,0,0,.38)',
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="duplicate-workflow-title"
        aria-describedby="duplicate-workflow-description"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 440,
          maxWidth: '100%',
          padding: 22,
          border: '1px solid var(--border)',
          borderRadius: 12,
          background: 'var(--surface)',
          boxShadow: '0 18px 50px rgba(0,0,0,.28)',
        }}
      >
        <div id="duplicate-workflow-title" style={{ fontSize: 17, fontWeight: 600 }}>
          Workflow already in use
        </div>
        <div
          id="duplicate-workflow-description"
          style={{ marginTop: 10, color: 'var(--text-2)', fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-line' }}
        >
          {message}
        </div>
        <div style={{ marginTop: 10, color: 'var(--text-3)', fontSize: 12.5, lineHeight: 1.5 }}>
          Existing scans will continue using the original workflow.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 22 }}>
          <Button variant="ghost" disabled={saving} onClick={onCancel}>
            Keep editing
          </Button>
          <Button data-autofocus disabled={saving} onClick={onConfirm}>
            {saving ? 'Saving duplicate…' : 'Save duplicate'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Label({ children, style, inline }) {
  return (
    <div
      className="mono"
      style={{ fontSize: 10, letterSpacing: '0.07em', color: 'var(--text-3)', marginBottom: inline ? 0 : 8, ...style }}
    >
      {children}
    </div>
  );
}

function BindingRouteBadge({ marker, direction }) {
  const peerName = marker.peer.name || `step ${marker.peer.id}`;
  const incoming = direction === 'incoming';
  const label = incoming ? `R${marker.number} input from ${peerName}` : `R${marker.number} output to ${peerName}`;
  return (
    <span
      className="mono"
      title={label}
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        maxWidth: '100%',
        border: `1px solid color-mix(in srgb, ${marker.color} 45%, var(--border))`,
        borderRadius: 5,
        padding: '2px 6px',
        background: marker.background,
        color: marker.color,
        fontSize: 9.5,
        fontWeight: 600,
        lineHeight: 1.35,
      }}
    >
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {incoming ? `R${marker.number} input ← ${peerName}` : `R${marker.number} output → ${peerName}`}
      </span>
    </span>
  );
}

function BindRouting({ sourceLevel, destinationLevel, onToggle, onChange }) {
  const enabled = !!destinationLevel?.bindPrevious;
  const countsMatch = sourceLevel.steps.length === destinationLevel?.steps.length;
  return (
    <div
      style={{
        marginBottom: 20,
        padding: '11px 12px',
        border: `1px solid ${enabled ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 8,
        background: enabled ? 'var(--accent-subtle)' : 'var(--surface-2)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div>
          <div className="mono" style={{ fontSize: 10, color: enabled ? 'var(--accent)' : 'var(--text-3)' }}>
            ADVANCED OUTPUT ROUTING - DEPTH {sourceLevel.depth} TO {destinationLevel.depth}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.45 }}>
            Route each sibling only to one sibling in the next depth.
          </div>
        </div>
        <button
          type="button"
          disabled={!enabled && !countsMatch}
          onClick={() => onToggle(!enabled)}
          aria-pressed={enabled}
          title={
            countsMatch
              ? 'Toggle one-to-one routing for this transition'
              : 'Both depths must have the same number of steps'
          }
          style={{
            flex: 'none',
            border: `1px solid ${enabled ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 6,
            padding: '5px 9px',
            background: enabled ? 'var(--accent)' : 'var(--surface)',
            color: enabled ? 'var(--accent-fg)' : countsMatch ? 'var(--text-2)' : 'var(--text-3)',
            cursor: enabled || countsMatch ? 'pointer' : 'not-allowed',
            fontSize: 11,
          }}
        >
          {enabled ? 'bind on' : 'bind off'}
        </button>
      </div>

      {!countsMatch && (
        <div style={{ color: 'var(--fail)', fontSize: 11, marginTop: 8 }}>
          Add or remove siblings until both depths have{' '}
          {Math.max(sourceLevel.steps.length, destinationLevel.steps.length)} steps, or turn bind off.
        </div>
      )}

      {enabled && (
        <div style={{ display: 'grid', gap: 7, marginTop: 11 }}>
          {destinationLevel.steps.map((destinationStep) => {
            const sourceIndex = sourceLevel.steps.findIndex(
              (sourceStep) => sourceStep.id === destinationStep.boundSourceStepId
            );
            const route = workflowBindingRouteToken(sourceIndex);
            return (
              <label
                key={destinationStep.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '28px minmax(0, 1fr) 18px minmax(0, 1fr)',
                  alignItems: 'center',
                  gap: 7,
                  borderLeft: route ? `3px solid ${route.color}` : '3px solid transparent',
                  borderRadius: 5,
                  padding: '4px 6px',
                  background: route ? route.background : 'transparent',
                }}
              >
                <span
                  className="mono"
                  style={{
                    color: route?.color || 'var(--text-3)',
                    fontSize: 10,
                    fontWeight: 700,
                    textAlign: 'center',
                  }}
                >
                  {route ? `R${route.number}` : '?'}
                </span>
                <select
                  aria-label={`Bound source for ${destinationStep.name || `step ${destinationStep.id}`}`}
                  value={destinationStep.boundSourceStepId || ''}
                  onChange={(event) => onChange(destinationStep.id, event.target.value)}
                  style={{
                    minWidth: 0,
                    border: '1px solid var(--border)',
                    borderRadius: 5,
                    background: 'var(--surface)',
                    color: 'var(--text)',
                    padding: '5px 7px',
                    fontSize: 11,
                  }}
                >
                  <option value="" disabled>
                    choose source
                  </option>
                  {sourceLevel.steps.map((sourceStep) => (
                    <option key={sourceStep.id} value={sourceStep.id}>
                      {sourceStep.name || `Step ${sourceStep.id}`}
                    </option>
                  ))}
                </select>
                <span style={{ color: route?.color || 'var(--text-3)', textAlign: 'center' }}>→</span>
                <span
                  title={destinationStep.name || `Step ${destinationStep.id}`}
                  style={{
                    minWidth: 0,
                    fontSize: 11,
                    color: 'var(--text-2)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {destinationStep.name || `Step ${destinationStep.id}`}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Segmented control: does this depth run one agent per previous result, or one
// agent over the whole batch? Shared across siblings of the depth.
function ConsumeToggle({ depth, batched, onOne, onAll }) {
  const prev = depth - 1;
  const explain = batched
    ? `One agent runs depth ${depth} with the full array of depth ${prev} outputs as {{multi_output_depth_${prev}}}. Individual depth-${prev} keys aren't available here or downstream.`
    : `A separate agent runs for each depth ${prev} result; this step sees that one result's keys.`;
  const opt = (active) => ({
    fontSize: 10.5,
    padding: '4px 11px',
    borderRadius: 5,
    cursor: 'pointer',
    background: active ? 'var(--surface)' : 'transparent',
    color: active ? 'var(--text)' : 'var(--text-3)',
    boxShadow: active ? 'var(--shadow)' : 'none',
  });
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span
          className="mono"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 10,
            letterSpacing: '0.07em',
            color: 'var(--text-3)',
          }}
        >
          INPUT · DEPTH {prev} RESULTS
          <span
            title={`${explain}\nShared across all depth ${depth} siblings.`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 14,
              height: 14,
              borderRadius: '50%',
              border: '1px solid var(--border)',
              color: 'var(--text-3)',
              fontSize: 9,
              fontStyle: 'italic',
              cursor: 'help',
            }}
          >
            i
          </span>
        </span>
        <div className="mono" style={{ display: 'flex', background: 'var(--surface-2)', borderRadius: 7, padding: 2 }}>
          <span onClick={onOne} style={opt(!batched)}>
            one at a time
          </span>
          <span onClick={onAll} style={opt(batched)}>
            all at once
          </span>
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 7, lineHeight: 1.5 }}>{explain}</div>
    </div>
  );
}

function RefSummary({ content, available }) {
  const parsed = parseTemplateRefs(content);
  const refs = [...new Set(parsed.refs)];
  const malformed = [...new Set(parsed.malformed)];
  const bad = malformed.length + refs.filter((k) => !refResolves(k, available, true)).length;
  const total = refs.length + malformed.length;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '16px 0 8px' }}>
        <Label inline>REFERENCED KEYS</Label>
        <span
          className="mono"
          style={{ fontSize: 10.5, color: bad ? 'var(--fail)' : total ? 'var(--ok)' : 'var(--text-3)' }}
        >
          {total === 0
            ? 'no references yet'
            : bad
              ? `${bad} invalid reference${bad > 1 ? 's' : ''}`
              : `all ${refs.length} resolved`}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {refs.map((k) => {
          const ok = refResolves(k, available, true);
          return (
            <span
              key={k}
              className="mono"
              style={{
                fontSize: 11,
                padding: '3px 9px',
                borderRadius: 6,
                color: ok ? 'var(--ok)' : 'var(--fail)',
                background: ok ? 'var(--ok-bg)' : 'var(--fail-bg)',
              }}
            >
              {ok ? '✓' : '✕'} {k}
            </span>
          );
        })}
        {malformed.map((token, index) => (
          <span
            key={`${token}-${index}`}
            className="mono"
            style={{
              fontSize: 11,
              padding: '3px 9px',
              borderRadius: 6,
              color: 'var(--fail)',
              background: 'var(--fail-bg)',
            }}
          >
            ✕ {token}
          </span>
        ))}
      </div>
    </>
  );
}

function LastStepBox({ missing, invalidTypes, onAddAll }) {
  const ok = missing.length === 0 && invalidTypes.length === 0;
  return (
    <div
      style={{
        marginTop: 16,
        borderRadius: 9,
        padding: '12px 14px',
        background: ok ? 'var(--ok-bg)' : 'var(--fail-bg)',
        border: `1px solid ${ok ? 'var(--ok-bg)' : 'var(--fail-bg)'}`,
      }}
    >
      {ok ? (
        <div style={{ fontSize: 12, color: 'var(--ok)' }}>
          ✓ All {REQUIRED_VULN_KEYS.length} required vulnerability keys and types are valid.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--fail)' }}>Terminal step has vulnerability output issues:</span>
            <span
              onClick={onAddAll}
              className="mono"
              style={{
                fontSize: 10.5,
                color: 'var(--accent)',
                cursor: 'pointer',
                border: '1px solid var(--accent)',
                borderRadius: 5,
                padding: '2px 7px',
              }}
            >
              fix all
            </span>
          </div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {missing.map((m) => (
              <span
                key={m}
                className="mono"
                style={{
                  fontSize: 10,
                  color: 'var(--fail)',
                  background: 'var(--fail-bg)',
                  padding: '2px 7px',
                  borderRadius: 5,
                }}
              >
                {m}
              </span>
            ))}
            {invalidTypes.map(({ key, expected, actual }) => (
              <span
                key={key}
                className="mono"
                style={{
                  fontSize: 10,
                  color: 'var(--fail)',
                  background: 'var(--fail-bg)',
                  padding: '2px 7px',
                  borderRadius: 5,
                }}
              >
                {key}: {actual} → {expected}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
