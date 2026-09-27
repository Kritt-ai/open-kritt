import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import SchemaEditor from './SchemaEditor.jsx';
import { objectToRows } from '../lib/keys.js';

const chain = {
  type: 'array',
  items: {
    type: 'object',
    fields: { id: 'string', status: { type: 'string', enum: ['proven', 'falsified'] } },
    required: ['id', 'status'],
  },
};
const rows = objectToRows({ summary: 'string', impact_chain: chain });
const noop = () => {};

describe('SchemaEditor', () => {
  it('renders a structured row read-only with its display type and a structured badge', () => {
    const html = renderToStaticMarkup(
      <SchemaEditor rows={rows} onRowsChange={noop} mode="visual" onToggleMode={noop} />
    );
    expect(html).toContain('array&lt;object&gt;');
    expect(html).toContain('structured');
    expect(html).toContain('data-structured="true"');
    expect(html).toMatch(/<select[^>]*disabled/);
    expect(html).toContain('Edit nested definitions in json mode');
    expect(html).toContain('<option value="object">object</option>');
  });

  it('keeps plain rows editable', () => {
    const html = renderToStaticMarkup(
      <SchemaEditor rows={objectToRows({ summary: 'string' })} onRowsChange={noop} mode="visual" onToggleMode={noop} />
    );
    expect(html).not.toContain('data-structured="true"');
    expect(html).not.toMatch(/<select[^>]*disabled/);
    expect(html).not.toContain('Edit nested definitions in json mode');
  });

  it('shows the nested descriptor in raw json mode', () => {
    const html = renderToStaticMarkup(<SchemaEditor rows={rows} onRowsChange={noop} mode="raw" onToggleMode={noop} />);
    expect(html).toContain('&quot;impact_chain&quot;');
    expect(html).toContain('&quot;enum&quot;');
    expect(html).toContain('&quot;falsified&quot;');
    expect(html).toContain('&quot;required&quot;');
    expect(html).not.toContain('array&lt;object&gt;');
  });
});
