import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { StepPanel, WorkflowStepCard } from './WorkflowDetail.jsx';
import Drawer from '../components/Drawer.jsx';
import { REQUIRED_VULN_KEYS } from '../lib/keys.js';

// A minimal terminal step: isLast triggers the "emits all N required vulnerability
// keys" summary. depth 0 with an empty steps array keeps availableKeysForDepth happy.
const terminalStep = {
  depth: 0,
  name: 'Report',
  content: '',
  multiOutput: false,
  consumesAll: false,
  outputTable: 'workflows.vulnerabilities',
  outputFormat: {},
  isLast: true,
};

describe('WorkflowDetail terminal step summary', () => {
  it('renders workflow steps as keyboard-operable controls', () => {
    const html = renderToStaticMarkup(
      <WorkflowStepCard step={terminalStep} steps={[terminalStep]} selected={false} onSelect={vi.fn()} />
    );

    expect(html).toContain('<button');
    expect(html).toContain('aria-label="Open step details: Report"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
  });

  it('exposes the opened step drawer as a labelled modal dialog', () => {
    const html = renderToStaticMarkup(
      <Drawer open onClose={vi.fn()} ariaLabel="Workflow step details">
        Step details
      </Drawer>
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Workflow step details"');
  });

  it('reports the real number of required vulnerability keys, not a hardcoded value', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StepPanel step={terminalStep} steps={[terminalStep]} editTo="/workflows/1/steps/1" onClose={vi.fn()} />
      </MemoryRouter>
    );

    expect(html).toContain(`emits all ${REQUIRED_VULN_KEYS.length} required vulnerability keys`);
    // Guard against the regression this test covers: the count was hardcoded to 9
    // while REQUIRED_VULN_KEYS actually has 8 entries.
    expect(html).not.toContain('emits all 9 required vulnerability keys');
  });

  it('identifies the selected source for a bound destination step', () => {
    const source = { ...terminalStep, id: '10', name: 'Map networking' };
    const destination = {
      ...terminalStep,
      id: '20',
      depth: 1,
      name: 'Review networking',
      boundSourceStepId: '10',
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StepPanel step={destination} steps={[source, destination]} editTo="/workflows/1/steps/20" onClose={vi.fn()} />
      </MemoryRouter>
    );

    expect(html).toContain('Bound input - this step receives results only from');
    expect(html).toContain('Map networking');
    expect(html).toContain('bound_source_step_id:');
  });
});
