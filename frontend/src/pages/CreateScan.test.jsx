import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../api/client.js';
import { ScanLaunchDialog, scanLaunchChoiceRequired } from './CreateScan.jsx';

describe('scan launch choice', () => {
  it('recognizes only the structured active-scan conflict', () => {
    expect(
      scanLaunchChoiceRequired(
        new ApiError('Choose a launch policy.', 409, [{ field: 'launchPolicy', message: 'Choose one.' }])
      )
    ).toBe(true);
    expect(scanLaunchChoiceRequired(new ApiError('Conflict.', 409))).toBe(false);
    expect(
      scanLaunchChoiceRequired(
        new ApiError('Choose a launch policy.', 422, [{ field: 'launchPolicy', message: 'Choose one.' }])
      )
    ).toBe(false);
  });

  it('offers concurrent and queued launch choices', () => {
    const html = renderToStaticMarkup(
      createElement(ScanLaunchDialog, {
        onClose: () => {},
        onChoose: () => {},
      })
    );

    expect(html).toContain('A scan is already running');
    expect(html).toContain('Start immediately');
    expect(html).toContain('Queue');
    expect(html).toContain('until capacity is available');
  });
});
