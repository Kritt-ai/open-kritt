// Status + severity presentation helpers (ported from the design logic).

export function rateLimitPresentation(reasoning) {
  if (reasoning?.limit_kind === 'runner_resource_limited') {
    return {
      label: 'Runner retry pending',
      message:
        'The runner was killed. The cause is unknown: memory pressure, a container limit, or an external stop may be responsible. Check Docker/container events and engine logs. Exit 137 alone does not prove a memory shortage.',
      accountRelated: false,
    };
  }
  if (reasoning?.limit_kind === 'provider_throttled') {
    return {
      label: 'Provider busy',
      message: 'The provider temporarily throttled server capacity; your account usage quota was not exhausted.',
      accountRelated: false,
    };
  }
  if (reasoning?.limit_kind === 'subagent_limited') {
    return {
      label: 'Subagent limit',
      message:
        'Codex reached a separate premium limit while starting a subagent; the account usage quota was not exhausted.',
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
  const subagentLimited = reasoning?.limit_kind === 'subagent_limited';
  const runnerLimited = reasoning?.limit_kind === 'runner_resource_limited';
  const label = runnerLimited
    ? 'Runner-termination autoscale'
    : subagentLimited
      ? 'Subagent-limit autoscale'
      : 'Provider-capacity autoscale';
  const cause = runnerLimited ? 'runner-termination' : subagentLimited ? 'subagent-limit' : 'capacity';
  return {
    initialCap,
    workerCap,
    reductions,
    compact: `${label}: ${initialCap} → ${workerCap} worker${workerCap === 1 ? '' : 's'}`,
    message: `${label} reduced this scan from ${initialCap} to ${workerCap} worker${
      workerCap === 1 ? '' : 's'
    } after ${reductions} ${cause} ${reductions === 1 ? 'event' : 'events'}. Future ${cause} errors lower it one worker at a time.`,
  };
}

export function storageWarningPresentation(reasoning, status = 'running') {
  if (!['prewarming_cache', 'running', 'post_processing'].includes(status)) return null;
  const warning = reasoning?.storage_warning;
  if (!warning || typeof warning !== 'object') return null;
  if (!['low_storage', 'storage_check_unavailable'].includes(warning.code)) return null;
  const toGiB = (value) => (Number.isSafeInteger(value) && value >= 0 ? value / 1024 ** 3 : null);
  const requiredGiB = toGiB(warning.required_bytes);
  const freeGiB = toGiB(warning.free_bytes);
  const unavailable = warning.code === 'storage_check_unavailable';
  const measured = freeGiB === null ? 'available space was not recorded' : `${Number(freeGiB.toFixed(3))} GiB was free`;
  const required =
    requiredGiB === null
      ? 'the threshold was not recorded'
      : `Minimum free storage was ${Number(requiredGiB.toFixed(3))} GiB`;
  const recordedAt = Date.parse(warning.detected_at);
  return {
    code: warning.code,
    freeGiB,
    requiredGiB,
    title: unavailable ? 'Storage check unavailable' : 'Waiting for storage',
    message:
      (unavailable
        ? 'Free space on the engine-data filesystem could not be measured; a disk shortage has not been established.'
        : `At the last reported check, ${measured} on the filesystem containing engine data; ${required}.`) +
      ' New container starts wait for a successful check with enough space. Checks repeat automatically; running containers continue.',
    detail:
      'This is the engine-data filesystem, which may differ from Docker image storage or other host disks. The minimum is a safety margin, not an estimate of the space this project will need.' +
      (freeGiB !== null && requiredGiB !== null && !unavailable
        ? ` GiB values are rounded; the recorded comparison is ${warning.free_bytes} bytes free versus ${warning.required_bytes} bytes required.`
        : ''),
    remedy: unavailable
      ? 'Check that the engine-data mount is accessible and review the engine logs. Restore the storage measurement before changing the safeguard.'
      : 'Free space or expand the disk containing engine data. For smaller projects, lowering Minimum free storage may allow starts with less free space, but increases the risk of filling the disk. It does not free space or guarantee completion.',
    observedAt: Number.isFinite(recordedAt) ? new Date(recordedAt).toISOString() : null,
    fixLinks: [{ label: 'Minimum free storage', url: '/settings#setting-minFreeStorageGb' }],
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
  let timing = 'when the retry is due';
  if (Number.isFinite(retryAt)) {
    const remainingSeconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
    if (remainingSeconds === 0) timing = 'shortly';
    else {
      const hours = Math.floor(remainingSeconds / 3600);
      const minutes = Math.floor((remainingSeconds % 3600) / 60);
      const seconds = remainingSeconds % 60;
      const countdown = [
        hours ? `${hours}h` : '',
        hours || minutes ? `${minutes}m` : '',
        `${String(seconds).padStart(2, '0')}s`,
      ]
        .filter(Boolean)
        .join(' ');
      timing = `in ${countdown}`;
    }
  }
  return `Automatic retry${retryCount ? ` #${retryCount}` : ''} ${timing}.`;
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
