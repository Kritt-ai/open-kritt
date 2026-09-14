import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ENGINE_RUNTIME_CONFIG_PATH } from './runtimeSettings.js';

const GIB = 1024 ** 3;
const MAX_AGE_MS = 60_000;
const ACTIVE_STATUSES = new Set(['pending', 'prewarming_cache', 'running', 'post_processing']);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const bytes = (value) => value === null || count(value);
const gib = (value) => `${Number((value / GIB).toFixed(3))} GiB`;
const settingLink = (key, label) => ({ label, url: `/settings#setting-${key}`, internal: true });

export async function readResourceDiagnostics({
  path = join(dirname(ENGINE_RUNTIME_CONFIG_PATH), 'engine-resource-diagnostics.json'),
  now = Date.now(),
} = {}) {
  try {
    const raw = await readFile(path, 'utf8');
    if (raw.length > 8192) return null;
    const snapshot = JSON.parse(raw);
    const observed = Date.parse(snapshot?.observedAt);
    const memory = snapshot?.memory;
    if (
      snapshot?.version !== 1 ||
      !Number.isFinite(observed) ||
      now - observed > MAX_AGE_MS ||
      observed - now > 5000 ||
      memory?.scope !== 'engine_linux_system' ||
      !bytes(memory.availableBytes) ||
      !bytes(memory.totalBytes) ||
      !count(memory.reserveBytes) ||
      !count(memory.runnerBytes) ||
      !count(memory.configuredWorkers) ||
      !count(memory.effectiveWorkers) ||
      memory.effectiveWorkers > memory.configuredWorkers
    )
      return null;
    // Return only the diagnostic fields, never arbitrary contents from the file.
    return {
      observedAt: new Date(observed).toISOString(),
      memory: Object.fromEntries(
        [
          'scope',
          'availableBytes',
          'totalBytes',
          'reserveBytes',
          'runnerBytes',
          'configuredWorkers',
          'effectiveWorkers',
        ].map((key) => [key, memory[key]])
      ),
    };
  } catch {
    return null;
  }
}

export function resourceWaitingNotice(status, snapshot, { generation = false } = {}) {
  if (!ACTIVE_STATUSES.has(status) || (generation && status !== 'pending')) return null;
  const memory = snapshot?.memory;
  if (!memory) {
    return status === 'pending'
      ? {
          title: 'Waiting for the engine',
          message:
            'Fresh resource measurements are unavailable. The reason for waiting is unknown; check that the engine is running and review its logs.',
        }
      : null;
  }
  if (memory.configuredWorkers === 0) {
    return {
      title: 'New work is paused',
      message:
        'Engine worker slots is set to 0. Set it above 0 in Settings to allow new work. Running work can finish.',
      fixLinks: [settingLink('workerCount', 'Engine worker slots')],
    };
  }
  const required = memory.reserveBytes + memory.runnerBytes;
  const capacityBlocked = memory.effectiveWorkers === 0 && memory.totalBytes > 0;
  const liveBlocked = !generation && memory.availableBytes !== null && memory.availableBytes < required;
  if (!capacityBlocked && !liveBlocked) {
    if (status !== 'pending') return null;
    return {
      title: 'Waiting for the engine',
      message:
        memory.availableBytes === null || memory.totalBytes === null
          ? 'Memory measurements are incomplete. The reason for waiting is unknown; check the engine logs.'
          : 'The latest memory check does not explain this wait. The engine may be busy or waiting on another condition; check its logs for details.',
    };
  }
  const measured = capacityBlocked
    ? `${gib(memory.totalBytes)} total memory`
    : `${gib(memory.availableBytes)} available memory`;
  return {
    title: 'Waiting for memory',
    message: `Current settings require ${gib(required)} for one new runner: ${gib(memory.reserveBytes)} Docker memory reserve + ${gib(memory.runnerBytes)} Runner memory reservation. The Linux system visible to the engine reports ${measured}. New work is checked again automatically; running work can finish.`,
    detail: `This measures the engine-visible Linux system (typically the Docker VM with Docker Desktop). Individual container limits and a remote Docker host may differ. GiB values are rounded; the exact comparison is ${capacityBlocked ? memory.totalBytes : memory.availableBytes} bytes ${capacityBlocked ? 'total' : 'available'} versus ${required} bytes required.${generation ? ' Draft generation also waits while this shared engine capacity is zero.' : ''}`,
    remedy:
      'Free memory by closing other workloads, use a machine with more memory, or allocate more memory to Docker if it runs in a VM. For smaller projects, lowering Runner memory reservation may allow work to start, but reduces the memory budget per runner and can increase contention or out-of-memory failures. It does not reduce actual memory use or change Runner hard memory limit. Lowering Docker memory reserve leaves less headroom for supporting services; it does not create memory or guarantee success.',
    observedAt: snapshot.observedAt,
    fixLinks: [
      settingLink('scanRunnerMemoryReservationMb', 'Runner memory reservation'),
      settingLink('memoryReserveGb', 'Docker memory reserve'),
    ],
  };
}

export function resourceFailure(value, { generation = false } = {}) {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  if (/diagnostic:\s*(?:network_error|provider_\w+|account_quota_limited|model_capacity)\b/.test(lower)) return null;
  if (
    lower.includes('resource diagnostic: storage_exhausted') ||
    /\b(enospc|no space left on device|disk quota exceeded)\b/.test(lower)
  ) {
    if (generation)
      return {
        key: 'engine_storage_full',
        title: 'Storage exhausted',
        message:
          'Generation reported no space or an exhausted disk quota. Available space, required space, and the affected filesystem were not recorded. Check the engine-data and temporary-file filesystems; free space or increase the relevant disk/quota, then retry generation.',
      };
    return {
      key: 'engine_storage_full',
      title: 'Storage exhausted',
      message:
        'The operation reported no space or an exhausted disk quota. Available space, the required amount, and the affected filesystem were not recorded. Check the engine-data filesystem and Docker storage, free space or increase the relevant disk/quota, then retry or resume. Lowering Minimum free storage cannot fix a full disk or quota; it only reduces the safety margin.',
      fixLinks: [settingLink('minFreeStorageGb', 'Minimum free storage')],
    };
  }
  if (
    lower.includes('resource diagnostic: memory_exhausted') ||
    /\b(cannot allocate memory|enomem|heap out of memory)\b|oomkilled["']?\s*[:=]\s*true/.test(lower)
  ) {
    if (generation)
      return {
        key: 'memory_exhausted',
        title: 'Memory exhausted',
        message:
          'The generation process reported memory exhaustion. Available and required memory were not recorded. Check memory available to the engine and its container or VM limits. Free memory or increase capacity, then retry generation. Runner hard memory limit applies to scan runners and does not cap generation calls.',
      };
    return {
      key: 'memory_exhausted',
      title: 'Memory exhausted',
      message:
        'The operation reported memory exhaustion. Memory available at failure and the required amount were not recorded, so a container limit and system-wide pressure cannot be distinguished. Check Docker/container memory usage and limits. Free memory or provide more memory. If a runner reached its cap, increasing Runner hard memory limit may help only when the system has enough headroom. Lowering the reservation or reserve does not reduce memory use.',
      fixLinks: [settingLink('scanRunnerMemoryMb', 'Runner hard memory limit')],
    };
  }
  if (lower.includes('diagnostic: runner_resource_limited') || /\bexit(?: code)? 137\b/.test(lower)) {
    return {
      key: 'runner_terminated',
      title: 'Runner terminated',
      message:
        'The runner was killed. Exit 137 alone does not establish memory exhaustion: a memory limit, system pressure, or an external stop may be responsible. Available resources and the cause were not recorded. Check Docker/container events and engine logs before changing resource settings. The task status indicates whether it is waiting to retry or has failed.',
      fixLinks: [settingLink('scanRunnerMemoryMb', 'Runner hard memory limit')],
    };
  }
  if (/resource diagnostic: cpu_unavailable|range of cpus is from/.test(lower)) {
    const reported = /reports (\d+) cpus available|as there are only (\d+) cpus available/.exec(lower);
    const cpus = reported ? Number(reported[1] || reported[2]) : null;
    const measurement =
      cpus > 0 && cpus <= 1048576
        ? `Docker reports ${cpus} CPUs available; the requested CPU value was not recorded.`
        : 'Reliable requested and available CPU measurements were not recorded.';
    return {
      key: 'runner_cpu_unavailable',
      title: 'Runner CPU configuration unavailable',
      message: `Docker rejected the requested CPU allocation. ${measurement} Check CPU capacity on the Docker host or VM and Runner CPU limit in Settings. If the limit exceeds that capacity, lower it or allocate more CPUs to Docker. A lower limit reduces the CPU time available to each runner and can slow CPU-heavy work.`,
      fixLinks: [settingLink('scanRunnerCpus', 'Runner CPU limit')],
    };
  }
  return null;
}
