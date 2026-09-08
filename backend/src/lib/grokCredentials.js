import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

import { scopedLoginEnvironment } from './accountLogins.js';

const GROK_PROBE_TIMEOUT_MS = 30_000;
const MAX_CAPTURED_OUTPUT = 32 * 1024;
const GROK_AUTH_REJECTION =
  /(?:not authenticated|not signed in|sign[- ]?in required|please (?:sign|log) in|authentication (?:failed|required)|invalid_grant|token[^\n]*(?:expired|invalid|revoked)|\b(?:401|403)\b[^\n]*(?:unauthorized|forbidden))/i;

function probeEnvironment(home, sourceEnvironment) {
  const env = {
    ...scopedLoginEnvironment(sourceEnvironment),
    HOME: dirname(home),
    GROK_HOME: home,
    GROK_TELEMETRY_ENABLED: 'false',
    GROK_TELEMETRY_TRACE_UPLOAD: 'false',
    GROK_TELEMETRY_MIXPANEL_ENABLED: 'false',
  };
  delete env.CI;
  return env;
}

export async function probeGrokCredential(
  home,
  { spawnProcess = spawn, timeoutMs = GROK_PROBE_TIMEOUT_MS, sourceEnvironment = process.env } = {}
) {
  return new Promise((resolve) => {
    let child;
    let output = '';
    let settled = false;
    let timeout;

    const finish = (statusKind) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ statusKind });
    };
    const capture = (chunk) => {
      output = `${output}${String(chunk)}`.slice(-MAX_CAPTURED_OUTPUT);
    };

    try {
      child = spawnProcess('grok', ['models'], {
        cwd: dirname(home),
        env: probeEnvironment(home, sourceEnvironment),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ statusKind: 'stale' });
      return;
    }

    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', () => finish('stale'));
    child.once('close', (code) => {
      if (GROK_AUTH_REJECTION.test(output)) finish('expired');
      else finish(code === 0 ? 'available' : 'stale');
    });

    timeout = setTimeout(() => {
      child.kill?.('SIGTERM');
      finish('stale');
    }, timeoutMs);
    timeout.unref?.();
  });
}
