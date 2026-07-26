const DIAGNOSTIC_SUFFIX_RE = /\s*Diagnostic:\s*([a-z0-9_-]+)\s*\(generation\s+(\d+)\)\.?\s*$/i;

const PROVIDER_LABELS = {
  codex: 'Codex',
  claude: 'Claude',
  openrouter: 'OpenRouter',
};

const HARNESS_LABELS = {
  codex: 'Codex CLI',
  'claude-code': 'Claude Code',
};

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function displayLabel(value, labels = {}) {
  const normalized = text(value);
  if (!normalized) return 'Not reported';
  return labels[normalized] || normalized;
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function splitGenerationFailureMessage(value) {
  const raw = text(value);
  const match = DIAGNOSTIC_SUFFIX_RE.exec(raw);
  if (!match) return { message: raw, diagnosticCode: null, diagnosticGenerationId: null };
  return {
    message: raw.slice(0, match.index).trim(),
    diagnosticCode: match[1].toLowerCase(),
    diagnosticGenerationId: match[2],
  };
}

export function formatGenerationDuration(startedAt, completedAt) {
  const started = validDate(startedAt);
  const completed = validDate(completedAt);
  if (!started || !completed || completed < started) return null;

  const seconds = Math.max(1, Math.round((completed.getTime() - started.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function formatGenerationTimestamp(value) {
  const date = validDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
}

export function normalizeGenerationValidationIssues(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string') {
      const message = entry.trim();
      return message ? [{ field: 'draft', message }] : [];
    }
    if (!entry || typeof entry !== 'object') return [];
    const field = text(entry.field) || 'draft';
    const message = text(entry.message);
    return message ? [{ field, message }] : [];
  });
}

export function generationFailureViewModel(job, kindLabel = 'draft') {
  const parsed = splitGenerationFailureMessage(job?.error);
  const issues = normalizeGenerationValidationIssues(job?.validationErrors);
  const generationId = text(job?.id?.toString()) || parsed.diagnosticGenerationId;
  const fallbackMessage = issues.length
    ? `The model returned a ${kindLabel}, but it did not satisfy the required structure.`
    : `The ${kindLabel} could not be generated. No additional safe diagnostic details were returned.`;

  return {
    title: `Could not generate the ${kindLabel}`,
    message: parsed.message || fallbackMessage,
    generationId,
    reference: generationId ? `Generation #${generationId}` : 'Generation reference unavailable',
    diagnosticCode: parsed.diagnosticCode,
    issues,
    configuration: [
      { label: 'Provider', value: displayLabel(job?.modelProvider, PROVIDER_LABELS) },
      { label: 'Model', value: displayLabel(job?.model) },
      { label: 'Harness', value: displayLabel(job?.harness, HARNESS_LABELS) },
      {
        label: 'Thinking',
        value: text(job?.thinkingEffort)
          ? `${text(job.thinkingEffort).slice(0, 1).toUpperCase()}${text(job.thinkingEffort).slice(1)}`
          : 'Not reported',
      },
    ],
    submittedAt: formatGenerationTimestamp(job?.insertedAt),
    startedAt: formatGenerationTimestamp(job?.runStartedAt),
    completedAt: formatGenerationTimestamp(job?.completedAt),
    duration: formatGenerationDuration(job?.runStartedAt, job?.completedAt),
  };
}

export function apiErrorMessages(error) {
  const details = Array.isArray(error?.errors)
    ? error.errors.flatMap((entry) => {
        if (typeof entry === 'string') return text(entry) ? [text(entry)] : [];
        if (!entry || typeof entry !== 'object') return [];
        const field = text(entry.field);
        const message = text(entry.message);
        if (!message) return [];
        return [field ? `${field}: ${message}` : message];
      })
    : [];
  if (details.length) return details;
  return [text(error?.message) || 'The generation request could not be submitted.'];
}
