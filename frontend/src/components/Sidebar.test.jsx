import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CommunityLinks, CommunityShareButton } from './Sidebar.jsx';

describe('sidebar community links', () => {
  it('renders every project and contact destination', () => {
    const html = renderToStaticMarkup(<CommunityLinks />);

    expect(html).toContain('aria-label="Project and community links"');
    expect(html).toContain('href="https://github.com/Kritt-ai/open-kritt"');
    expect(html).toContain('href="https://x.com/Kritt_AI"');
    expect(html).toContain('href="https://kritt.ai/"');
    expect(html).toContain('href="https://discord.gg/JJr2CbBjc"');
    expect(html).toContain('href="mailto:info@kritt.ai"');
    expect(html.match(/target="_blank"/g)).toHaveLength(4);
    expect(html.match(/rel="noreferrer"/g)).toHaveLength(4);
  });

  it('renders the persistent community sharing call to action', () => {
    const html = renderToStaticMarkup(<CommunityShareButton onClick={() => {}} />);

    expect(html).toContain('Give back to the community by sharing');
    expect(html).toContain('Share open·kritt');
    expect(html).toContain('type="button"');
  });
});
