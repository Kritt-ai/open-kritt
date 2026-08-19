import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RuntimeSettingsFields } from './Settings.jsx';

describe('runtime settings fields', () => {
  it('renders available fields and warns when the backend omits newer settings', () => {
    const html = renderToStaticMarkup(
      <RuntimeSettingsFields
        data={{
          settings: {
            workerCount: {
              value: 2,
              source: 'default',
              valid: true,
              envKey: 'ENGINE_WORKER_COUNT',
              type: 'integer',
              min: 0,
              max: 128,
              recommendedMax: 10,
              apply: 'live',
            },
          },
        }}
        draft={{ workerCount: '2' }}
        issues={{}}
        saving={false}
        onChange={() => {}}
      />
    );

    expect(html).toContain('Some settings are unavailable from the running backend');
    expect(html).toContain('Restart the backend to load the current settings schema.');
    expect(html).toContain('id="setting-workerCount"');
    expect(html).not.toContain('id="setting-ignoreLowStorage"');
  });

  it('explains the total attempt count when cyber-block retries are enabled', () => {
    const html = renderToStaticMarkup(
      <RuntimeSettingsFields
        data={{
          settings: {
            cyberSafetyRetryCount: {
              value: 3,
              source: 'runtime_config',
              valid: true,
              envKey: 'ENGINE_CYBER_SAFETY_RETRY_COUNT',
              type: 'integer',
              min: 0,
              max: 10,
              recommendedMax: 3,
              apply: 'live',
            },
          },
        }}
        draft={{ cyberSafetyRetryCount: '3' }}
        issues={{}}
        saving={false}
        onChange={() => {}}
      />
    );

    expect(html).toContain('id="setting-cyberSafetyRetryCount"');
    expect(html).toContain('up to 4 total attempts');
    expect(html).toContain('ENGINE_CYBER_SAFETY_RETRY_COUNT');
  });
});
