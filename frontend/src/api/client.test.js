import { describe, expect, it } from 'vitest';
import { api, attachmentFilename, resolveApiBase } from './client.js';

describe('resolveApiBase', () => {
  it('uses same-origin requests when no API base is configured', () => {
    expect(resolveApiBase('', { hostname: 'scanner.example', origin: 'https://scanner.example' })).toBe('');
  });

  it('drops a localhost override when the UI is viewed remotely', () => {
    expect(
      resolveApiBase('http://localhost:3002/', {
        hostname: 'scanner.example',
        origin: 'https://scanner.example',
      })
    ).toBe('');
  });

  it('drops a localhost override for local development so Vite can proxy it', () => {
    expect(
      resolveApiBase('http://localhost:3002/', {
        hostname: 'localhost',
        origin: 'http://localhost:5173',
      })
    ).toBe('');
  });

  it('drops a numeric loopback override for local development', () => {
    expect(
      resolveApiBase('http://127.0.0.1:3002/', {
        hostname: '127.0.0.1',
        origin: 'http://127.0.0.1:5173',
      })
    ).toBe('');
  });

  it('keeps a configured remote API origin', () => {
    expect(
      resolveApiBase('https://api.example/', {
        hostname: 'scanner.example',
        origin: 'https://scanner.example',
      })
    ).toBe('https://api.example');
  });
});

describe('provider account API', () => {
  it('passes the expired Codex account when signing in again', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, status: 201, json: async () => ({ id: 'login-session' }) };
    };

    try {
      await api.startProviderLogin('codex', 'account/one');
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(request.url).toBe('/api/accounts/codex/login');
    expect(request.options.method).toBe('POST');
    expect(JSON.parse(request.options.body)).toEqual({ accountId: 'account/one' });
  });

  it('loads one provider without waiting for the others', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ id: 'claude', accounts: [] }) };
    };

    try {
      await api.accountProvider('claude', true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(request.url).toBe('/api/accounts/provider/claude?refresh=1');
    expect(request.options.cache).toBe('no-store');
  });

  it('encodes account identifiers in the removal request', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ providers: [] }),
      };
    };

    try {
      await api.removeProviderAccount('codex', 'account/one');
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(request.url).toBe('/api/accounts/codex/account/account%2Fone');
    expect(request.options.method).toBe('DELETE');
  });

  it('starts weekly Codex usage for the encoded account identifier', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ providers: [] }),
      };
    };

    try {
      await api.startCodexWeeklyUsage('account/one');
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(request.url).toBe('/api/accounts/codex/account/account%2Fone/start-weekly');
    expect(request.options.method).toBe('POST');
  });

  it('requests a manual reset for the encoded Codex account identifier', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ providers: [] }),
      };
    };

    try {
      await api.useCodexManualReset('account/one');
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(request.url).toBe('/api/accounts/codex/account/account%2Fone/reset');
    expect(request.options.method).toBe('POST');
    expect(JSON.parse(request.options.body)).toEqual({ confirm: 'use-reset' });
  });
});

describe('scan lifecycle API', () => {
  it('requests a bounded scan page with its status filter', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ items: [], totalItems: 0 }) };
    };
    try {
      await api.scanPage({ status: 'completed', page: 3, pageSize: 6 });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(request.url).toBe('/api/scans?page=3&pageSize=6&status=completed');
  });

  it('resumes through pending so the scheduler can enforce pool limits', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ status: 'pending' }) };
    };
    try {
      await api.resumeScan('58');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(request.url).toBe('/api/scans/58');
    expect(request.options.method).toBe('PATCH');
    expect(JSON.parse(request.options.body)).toEqual({ status: 'pending' });
  });

  it('deletes a scan with DELETE', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, status: 204, json: async () => ({}) };
    };
    try {
      await api.deleteScan('58');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(request.url).toBe('/api/scans/58');
    expect(request.options.method).toBe('DELETE');
  });

  it('downloads a completed scan finding archive with the server filename', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    const blob = new Blob(['zip']);
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        blob: async () => blob,
        headers: new Headers({ 'Content-Disposition': 'attachment; filename="protocol-scan-58-findings.zip"' }),
      };
    };
    let result;
    try {
      result = await api.exportScanFindings('58');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(request.url).toBe('/api/scans/58/export');
    expect(request.options.cache).toBe('no-store');
    expect(result).toEqual({ blob, filename: 'protocol-scan-58-findings.zip' });
  });
});

describe('attachmentFilename', () => {
  it('supports encoded filenames and strips any archive path', () => {
    expect(attachmentFilename("attachment; filename*=UTF-8''Protocol%20findings.zip")).toBe('Protocol findings.zip');
    expect(attachmentFilename('attachment; filename="../unsafe/findings.zip"')).toBe('findings.zip');
  });

  it('falls back when the header has no filename', () => {
    expect(attachmentFilename('', 'scan-findings.zip')).toBe('scan-findings.zip');
  });
});

describe('workflow lifecycle API', () => {
  it('preserves machine-readable workflow conflict details', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'Workflow is in use.',
        code: 'workflow_in_use',
        scanCount: 5,
      }),
    });

    try {
      await expect(api.updateWorkflow('27', { name: 'edited' })).rejects.toMatchObject({
        message: 'Workflow is in use.',
        status: 409,
        code: 'workflow_in_use',
        data: { scanCount: 5 },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('deletes a workflow with DELETE', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, status: 204, json: async () => ({}) };
    };
    try {
      await api.deleteWorkflow('27');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(request.url).toBe('/api/workflows/27');
    expect(request.options.method).toBe('DELETE');
  });
});

describe('local repository API', () => {
  it('encodes the repository name when requesting file stats', async () => {
    const originalFetch = globalThis.fetch;
    const signal = new AbortController().signal;
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: 'working tree #1', fileCount: 42, complete: true, snapshotIssues: [] }),
      };
    };

    try {
      await api.localRepoStats('working tree #1', { signal });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(request.url).toBe('/api/local-repos/working%20tree%20%231/stats');
    expect(request.options.method).toBeUndefined();
    expect(request.options.signal).toBe(signal);
  });
});
