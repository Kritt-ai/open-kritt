import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { WorkflowCard } from './Workflows.jsx';

const workflow = {
  id: '27',
  name: 'Custom review',
  description: 'Review a repository.',
  stepCount: 1,
  depthChips: [{ depth: 0, count: 1, label: 'd0' }],
  lastUsed: null,
  isDefault: false,
  scanCount: 0,
};

function renderCard(overrides = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <WorkflowCard workflow={{ ...workflow, ...overrides }} busy={false} deleting={false} onDelete={() => {}} />
    </MemoryRouter>
  );
}

describe('WorkflowCard deletion action', () => {
  it('offers deletion for an unused custom workflow', () => {
    expect(renderCard()).toContain('aria-label="Delete Custom review"');
  });

  it('does not offer deletion for a workflow with scans', () => {
    expect(renderCard({ scanCount: 1 })).not.toContain('aria-label="Delete Custom review"');
  });

  it('does not offer deletion for a built-in workflow', () => {
    expect(renderCard({ isDefault: true })).not.toContain('aria-label="Delete Custom review"');
  });
});
