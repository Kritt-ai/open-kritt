// Status + severity presentation helpers (ported from the design logic).

export function rateLimitPresentation(reasoning) {
  if (reasoning?.limit_kind === 'provider_throttled') {
    return {
      label: 'Provider busy',
      message: 'The provider temporarily throttled server capacity; your account usage quota was not exhausted.',
      accountRelated: false,
    };
  }
  if (reasoning?.limit_kind === 'account_quota_limited') {
    return {
      label: 'Quota exhausted',
      message: 'The provider reports that this account reached its usage quota.',
      accountRelated: true,
    };
  }
  return {
    label: 'Rate limited',
    message: 'The provider is temporarily rate limiting requests.',
    accountRelated: true,
  };
}

export function providerCapacityAutoscalePresentation(reasoning) {
  const initialCap = reasoning?.provider_capacity_initial_worker_cap;
  const workerCap = reasoning?.provider_capacity_worker_cap;
  const events = reasoning?.provider_capacity_autoscale_events;
  if (
    reasoning?.provider_capacity_autoscale_enabled !== true ||
    !Number.isInteger(initialCap) ||
    initialCap < 1 ||
    !Number.isInteger(workerCap) ||
    workerCap < 1
  )
    return null;
  const reductions = Number.isInteger(events) && events > 0 ? events : Math.max(0, initialCap - workerCap);
  return {
    initialCap,
    workerCap,
    reductions,
    compact: `Provider-capacity autoscale: ${initialCap} → ${workerCap} worker${workerCap === 1 ? '' : 's'}`,
    message: `Provider-capacity autoscaling reduced this scan from ${initialCap} to ${workerCap} worker${
      workerCap === 1 ? '' : 's'
    } after ${reductions} capacity ${reductions === 1 ? 'event' : 'events'}. Future capacity errors lower it one worker at a time.`,
  };
}

export function storageWarningPresentation(reasoning) {
  const warning = reasoning?.storage_warning;
  if (!warning || typeof warning !== 'object') return null;
  const requiredGiB = Number(warning.required_bytes) / 1024 ** 3;
  const freeGiB = warning.free_bytes == null ? null : Number(warning.free_bytes) / 1024 ** 3;
  const fallback =
    warning.code === 'storage_check_unavailable'
      ? 'New scan containers are paused because free storage could not be checked. The scan will resume automatically after the check succeeds.'
      : `New scan containers are paused${Number.isFinite(freeGiB) ? ` at ${freeGiB.toFixed(1)} GiB free` : ''}${
          Number.isFinite(requiredGiB) ? `; ${requiredGiB.toFixed(0)} GiB is required` : ''
        }. Running containers are not interrupted, and the scan will resume automatically when space is available.`;
  return {
    code: warning.code || 'low_storage',
    freeGiB: Number.isFinite(freeGiB) ? freeGiB : null,
    requiredGiB: Number.isFinite(requiredGiB) ? requiredGiB : null,
    message: typeof warning.message === 'string' && warning.message.trim() ? warning.message : fallback,
  };
}

export function statusMeta(status, reasoning) {
  const map = {
    completed: { label: 'Completed', color: 'var(--ok)', bg: 'var(--ok-bg)', pulse: 'none' },
    running: { label: 'Running', color: 'var(--run)', bg: 'var(--run-bg)', pulse: 'okpulse 1.4s ease-in-out infinite' },
    prewarming_cache: {
      label: 'Prewarming cache',
      color: 'var(--pend)',
      bg: 'var(--pend-bg)',
      pulse: 'okpulse 1.4s ease-in-out infinite',
    },
    post_processing: {
      label: 'Post-processing',
      color: 'var(--run)',
      bg: 'var(--run-bg)',
      pulse: 'okpulse 1.4s ease-in-out infinite',
    },
    paused: { label: 'Paused', color: 'var(--stop)', bg: 'var(--stop-bg)', pulse: 'none' },
    queued: { label: 'Queued', color: 'var(--pend)', bg: 'var(--pend-bg)', pulse: 'none' },
    pending: {
      label: 'Pending',
      color: 'var(--pend)',
      bg: 'var(--pend-bg)',
      pulse: 'okpulse 1.8s ease-in-out infinite',
    },
    rate_limited: {
      label: rateLimitPresentation(reasoning).label,
      color: 'var(--pend)',
      bg: 'var(--pend-bg)',
      pulse: 'okpulse 1.8s ease-in-out infinite',
    },
    failed: { label: 'Failed', color: 'var(--fail)', bg: 'var(--fail-bg)', pulse: 'none' },
    stopped: { label: 'Stopped', color: 'var(--stop)', bg: 'var(--stop-bg)', pulse: 'none' },
  };
  return map[status] || { label: status, color: 'var(--text-3)', bg: 'var(--surface-2)', pulse: 'none' };
}

export function rateLimitRetryText(reasoning, now = Date.now()) {
  const retryCount =
    Number.isInteger(reasoning?.retry_count) && reasoning.retry_count > 0 ? reasoning.retry_count : null;
  const retryAt = Date.parse(reasoning?.retry_after || '');
  const backoffSeconds =
    typeof reasoning?.backoff_seconds === 'number' && Number.isFinite(reasoning.backoff_seconds)
      ? Math.max(0, Math.ceil(reasoning.backoff_seconds))
      : null;
  const providerRetryAfterSeconds =
    typeof reasoning?.provider_retry_after_seconds === 'number' && Number.isFinite(reasoning.provider_retry_after_seconds)
      ? Math.max(0, Math.ceil(reasoning.provider_retry_after_seconds))
      : null;
  let timing = 'when the retry is due';
  if (Number.isFinite(retryAt)) {
    const remainingSeconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
    if (remainingSeconds === 0) timing = 'shortly';
    else timing = `in ${formatDuration(remainingSeconds)}`;
  }
  const details = [];
  if (backoffSeconds != null) details.push(`backoff ${formatDuration(backoffSeconds)}`);
  if (providerRetryAfterSeconds != null) details.push(`provider Retry-After ${formatDuration(providerRetryAfterSeconds)}`);
  return `Automatic retry${retryCount ? ` #${retryCount}` : ''} ${timing}${details.length ? ` (${details.join(', ')})` : ''}.`;
}

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.ceil(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}h` : '', hours || minutes ? `${minutes}m` : '', `${String(remainder).padStart(2, '0')}s`]
    .filter(Boolean)
    .join(' ');
}

export function sevColor(sev) {
  const key = String(sev || '').toLowerCase();
  return (
    {
      critical: 'var(--fail)',
      high: 'var(--fail)',
      medium: 'var(--pend)',
      low: 'var(--run)',
      informational: 'var(--text-3)',
      info: 'var(--text-3)',
    }[key] || 'var(--text-3)'
  );
}

// Best-effort severity from a finding's post-script answer.
export function findingSeverity(vuln) {
  return (
    vuln?.severity ||
    vuln?.postScriptAnswer?.severity ||
    (vuln?.enrichments || []).find((e) => e?.result?.severity)?.result?.severity ||
    vuln?.bountyRank?.impactLevel ||
    null
  );
}
