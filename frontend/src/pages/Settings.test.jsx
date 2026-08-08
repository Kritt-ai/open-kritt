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
});
