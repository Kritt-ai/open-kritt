import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ShareResultDialog from './ShareResultDialog.jsx';

describe('ShareResultDialog', () => {
  it('renders the branded privacy controls', () => {
    const html = renderToStaticMarkup(<ShareResultDialog severity="critical" onClose={() => {}} />);

    expect(html).toContain('It’s open source. Give back to the community.');
    expect(html).toContain('Share-card preview: I found a vulnerability using open·kritt.');
    expect(html).toContain('width="1200"');
    expect(html).toContain('height="630"');
    expect(html).toContain('Include severity');
    expect(html).toContain('Share on X');
    expect(html).toContain('Share elsewhere');
    expect(html).not.toContain('Don’t show this automatically again');
    expect(html).toContain('No repository, finding title, path, code, report, PoC');
    expect(html).not.toContain('Star on GitHub');
  });

  it('renders a project-focused community sharing prompt without scan controls', () => {
    const html = renderToStaticMarkup(<ShareResultDialog mode="community" onClose={() => {}} />);

    expect(html).toContain('Support the open-source community.');
    expect(html).toContain('Share open·kritt with other researchers or star it on GitHub.');
    expect(html).toContain('Open-source security is stronger when we build together.');
    expect(html).toContain('No scan or vulnerability data is included.');
    expect(html).toContain('Prefer not to post?');
    expect(html).toContain('A GitHub star is a quick way to help open·kritt grow.');
    expect(html).toContain('href="https://github.com/Kritt-ai/open-kritt"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html.indexOf('Prefer not to post?')).toBeLessThan(html.indexOf('Share-card preview'));
    expect(html).not.toContain('Include severity');
    expect(html).not.toContain('Don’t show this automatically again');
  });

  it('keeps the severity control out when unavailable', () => {
    const html = renderToStaticMarkup(<ShareResultDialog onClose={() => {}} />);

    expect(html).not.toContain('Include severity');
    expect(html).not.toContain('Don’t show this automatically again');
    expect(html).toContain('Copy post');
    expect(html).toContain('Download PNG');
  });
});
