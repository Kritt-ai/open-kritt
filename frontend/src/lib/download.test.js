import { describe, expect, it, vi } from 'vitest';

import { saveBrowserDownload } from './download.js';

describe('saveBrowserDownload', () => {
  it('clicks a temporary link and revokes the object URL', () => {
    const link = {
      style: {},
      click: vi.fn(),
      remove: vi.fn(),
    };
    const documentRef = {
      createElement: vi.fn(() => link),
      body: { appendChild: vi.fn() },
    };
    const urlApi = {
      createObjectURL: vi.fn(() => 'blob:findings'),
      revokeObjectURL: vi.fn(),
    };
    const schedule = vi.fn((callback) => callback());
    const blob = new Blob(['zip']);

    saveBrowserDownload({ blob, filename: 'findings.zip' }, { documentRef, urlApi, schedule });

    expect(urlApi.createObjectURL).toHaveBeenCalledWith(blob);
    expect(link.href).toBe('blob:findings');
    expect(link.download).toBe('findings.zip');
    expect(documentRef.body.appendChild).toHaveBeenCalledWith(link);
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:findings');
  });
});
