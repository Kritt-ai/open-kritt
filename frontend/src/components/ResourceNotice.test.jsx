import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import ResourceNotice from './ResourceNotice.jsx';
import { ScanCard } from '../pages/Scans.jsx';
import { storageWarningPresentation, rateLimitPresentation } from '../lib/format.js';

const render = (element) => renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);
const notice = {
  title: 'Waiting for memory',
  message: 'Current settings require 2 GiB; 1.5 GiB is available.',
  detail: 'Linux system visible to the engine.',
  remedy: 'Free memory or increase the memory available to Docker.',
  fixLinks: [{ label: 'Runner memory reservation', url: '/settings#setting-scanRunnerMemoryReservationMb' }],
};

describe('resource notices', () => {
  it('renders readable status, native expandable details and a settings control link', () => {
    const html = render(<ResourceNotice notice={notice} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('Current settings require 2 GiB; 1.5 GiB is available.');
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('href="/settings#setting-scanRunnerMemoryReservationMb"');
    expect(render(<ResourceNotice notice={null} />)).toBe('');
    expect(render(<ResourceNotice notice={{ title: '<script>bad</script>', message: '<img>' }} />)).not.toContain(
      '<script>'
    );
  });

  it('shows the resource reason on a pending card instead of promising imminent pickup', () => {
    const html = render(
      <ScanCard scan={{ id: '7', repoFull: 'example/demo', status: 'pending', resourceNotice: notice }} to="/scans/7" />
    );
    expect(html).toContain('Waiting for memory');
    expect(html).not.toContain('pick this up shortly');
    expect(html).not.toContain('No specific waiting reason');
  });

  it('labels disk readings as recorded and preserves fractional thresholds', () => {
    const storage = storageWarningPresentation({
      storage_warning: { code: 'low_storage', free_bytes: 1.25 * 1024 ** 3, required_bytes: 1.75 * 1024 ** 3 },
    });
    expect(storage.message).toContain('At the last reported check, 1.25 GiB was free');
    expect(storage.message).toContain('Minimum free storage was 1.75 GiB');
    expect(storage.detail).toContain('may differ from Docker image storage');
    expect(storage.remedy).toContain('does not free space');
    expect(storageWarningPresentation({ storage_warning: { code: 'storage_check_unavailable' } }).message).toContain(
      'a disk shortage has not been established'
    );
    expect(storageWarningPresentation({ storage_warning: { code: 'low_storage' } }).message).not.toContain('0 GiB');
    expect(storageWarningPresentation({ storage_warning: { code: 'unrecognized' } })).toBeNull();
    expect(storageWarningPresentation({ storage_warning: { code: 'low_storage' } }, 'failed')).toBeNull();
  });

  it('does not present a runner kill as a provider quota or a confirmed memory shortage', () => {
    const retry = rateLimitPresentation({ limit_kind: 'runner_resource_limited' });
    expect(retry.accountRelated).toBe(false);
    expect(retry.label).toBe('Runner retry pending');
    expect(retry.message).toContain('cause is unknown');
    const html = render(
      <ScanCard
        scan={{ id: '7', status: 'rate_limited', reasoning: { limit_kind: 'runner_resource_limited' } }}
        to="/scans/7"
      />
    );
    expect(html).toContain('Runner retry pending');
    expect(html).not.toContain('View usage and provider limits');
  });
});
