import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ShareResultDialog from './ShareResultDialog.jsx';

describe('ShareResultDialog', () => {
  it('renders the branded privacy controls and automatic-prompt opt-out', () => {
    const html = renderToStaticMarkup(<ShareResultDialog severity="critical" automatic onClose={() => {}} />);

    expect(html).toContain('It’s open source. Give back to the community.');
    expect(html).toContain('Share-card preview: I found a vulnerability using open·kritt.');
    expect(html).toContain('width="1200"');
    expect(html).toContain('height="630"');
    expect(html).toContain('Include highest severity');
    expect(html).toContain('Share on X');
    expect(html).toContain('Share elsewhere');
    expect(html).toContain('Don’t show this automatically again');
    expect(html).toContain('No repository, finding title, path, code, report, PoC');
  });

  it('renders a project-focused community sharing prompt without scan controls', () => {
    const html = renderToStaticMarkup(<ShareResultDialog mode="community" onClose={() => {}} />);

    expect(html).toContain('It’s open source. Give back to the community.');
    expect(html).toContain('Open-source security is stronger when we build together.');
    expect(html).toContain('No scan or vulnerability data is included.');
    expect(html).not.toContain('Include highest severity');
    expect(html).not.toContain('Don’t show this automatically again');
  });

  it('keeps the severity control and automatic opt-out out when unavailable or manually opened', () => {
    const html = renderToStaticMarkup(<ShareResultDialog onClose={() => {}} />);

    expect(html).not.toContain('Include highest severity');
    expect(html).not.toContain('Don’t show this automatically again');
    expect(html).toContain('Copy post');
    expect(html).toContain('Download PNG');
  });
});
