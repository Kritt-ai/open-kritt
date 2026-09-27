import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import ScanGraph, { layoutScanGraph, NODE_WIDTH, outcomeLabel, ScanGraphPanel } from './ScanGraph.jsx';

const attempts = (overrides = {}) => ({
  completed: 0,
  running: 0,
  failed: 0,
  interrupted: 0,
  stopped: 0,
  ...overrides,
});

const graph = {
  scanId: '9',
  status: 'post_processing',
  nodes: [
    {
      id: '1',
      stepId: '1',
      name: 'Map entrypoints',
      depth: 0,
      isLastStep: false,
      boundSourceStepId: null,
      attempts: attempts({ completed: 1 }),
      stubs: 0,
      expected: 1,
      records: 2,
    },
    {
      id: '2',
      stepId: '2',
      name: 'D1 authority',
      depth: 1,
      isLastStep: false,
      boundSourceStepId: null,
      attempts: attempts({ completed: 2 }),
      stubs: 1,
      expected: 2,
      records: 1,
    },
    {
      id: '3',
      stepId: '3',
      name: 'D1 state',
      depth: 1,
      isLastStep: false,
      boundSourceStepId: null,
      attempts: attempts({ completed: 1, running: 1 }),
      stubs: 0,
      expected: 2,
      records: 1,
    },
    {
      id: '5',
      stepId: '5',
      name: 'D2 authority',
      depth: 2,
      isLastStep: true,
      boundSourceStepId: '2',
      attempts: attempts({ completed: 1 }),
      stubs: 0,
      expected: 1,
      records: 2,
    },
    {
      id: '6',
      stepId: '6',
      name: 'D2 state',
      depth: 2,
      isLastStep: true,
      boundSourceStepId: '3',
      attempts: attempts({ failed: 1 }),
      stubs: 0,
      expected: 1,
      records: 0,
    },
  ],
  edges: [
    { from: '1', to: '2', lineages: 2, expected: 2 },
    { from: '1', to: '3', lineages: 2, expected: 2 },
    { from: '2', to: '5', lineages: 1, expected: 1 },
    { from: '3', to: '6', lineages: 1, expected: 2 },
  ],
  post: {
    rawFindings: 3,
    canonicalFindings: 2,
    duplicateFindings: 1,
    stages: [
      { id: 'dedupe', kind: 'dedupe', name: 'Semantic dedupe', attempts: attempts({ completed: 1 }) },
      { id: 'ranker', kind: 'ranker', name: 'Severity ranker', attempts: attempts() },
      {
        id: 'post_script:11',
        kind: 'post_script',
        postScriptId: '11',
        name: 'v2.7 D3 Hostile Canonical Verification',
        attempts: attempts({ completed: 2 }),
        enrichments: 2,
        stubs: 0,
        outcomes: { verdict: { confirmed: 1, false_positive: 1 } },
      },
      {
        id: 'post_script:12',
        kind: 'post_script',
        postScriptId: '12',
        name: 'v2.7 D4 Local PoC and Negative Control',
        attempts: attempts({ running: 1 }),
        enrichments: 0,
        stubs: 0,
        outcomes: {},
      },
    ],
  },
};

describe('layoutScanGraph', () => {
  it('places one column per depth and stacks sibling steps vertically', () => {
    const layout = layoutScanGraph(graph);
    expect(layout.columns.map((column) => column.depth)).toEqual([0, 1, 2]);
    const [d0, d1, d2] = layout.columns;
    expect(d0.x).toBeLessThan(d1.x);
    expect(d1.x).toBeLessThan(d2.x);
    const lane = (id) => layout.nodes.find((node) => node.id === id);
    expect(lane('2').x).toBe(lane('3').x);
    expect(lane('2').y).toBeLessThan(lane('3').y);
    expect(lane('1').y).toBeGreaterThan(lane('2').y);
    expect(lane('1').y).toBeLessThan(lane('3').y);
    expect(layout.width).toBeGreaterThan(d2.x + NODE_WIDTH);
    expect(layout.height).toBeGreaterThan(lane('3').y);
  });

  it('draws each edge from the source right edge to the destination left edge', () => {
    const layout = layoutScanGraph(graph);
    const edge = layout.edges.find((item) => item.from === '3' && item.to === '6');
    const source = layout.nodes.find((node) => node.id === '3');
    const target = layout.nodes.find((node) => node.id === '6');
    expect(edge.x1).toBe(source.x + source.width);
    expect(edge.x2).toBe(target.x);
    expect(edge.y1).toBe(source.y + source.height / 2);
    expect(edge.y2).toBe(target.y + target.height / 2);
    expect(edge.path).toMatch(/^M /);
  });

  it('handles a graph with no nodes', () => {
    const layout = layoutScanGraph({ nodes: [], edges: [], post: { stages: [] } });
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
  });
});

describe('ScanGraph', () => {
  const html = renderToStaticMarkup(<ScanGraph graph={graph} selectedStepId="3" />);

  it('renders every step as an SVG node with progress and record counts', () => {
    expect(html).toContain('<svg');
    expect(html).toContain('Map entrypoints');
    expect(html).toContain('aria-label="Depth 1 step D1 state: 1 of 2 lineages completed, 1 running, 1 record"');
    expect(html).toContain('aria-label="Depth 1 step D1 authority: 2 of 2 lineages completed, 1 stub, 1 record"');
    expect(html).toContain('aria-label="Depth 2 step D2 state: 0 of 1 lineages completed, 1 failed, 0 findings"');
    expect(html).toContain('data-step-id="3"');
    expect(html).toContain('data-selected="true"');
  });

  it('labels edges with attempted over expected lineages', () => {
    expect(html).toContain('aria-label="D1 state to D2 state: 1 of 2 lineages"');
    expect(html).toContain('aria-label="Map entrypoints to D1 authority: 2 of 2 lineages"');
  });

  it('renders the post-processing funnel with dedupe totals and outcomes', () => {
    expect(html).toContain('3 raw');
    expect(html).toContain('2 canonical');
    expect(html).toContain('1 duplicate');
    expect(html).toContain('Semantic dedupe');
    expect(html).toContain('v2.7 D3 Hostile Canonical Verification');
    expect(html).toContain('confirmed 1');
    expect(html).toContain('false_positive 1');
    expect(html).toContain('v2.7 D4 Local PoC and Negative Control');
    expect(html).toContain('1 running');
    expect(html).toContain('2 done');
    expect(html).toContain('>verdict<');
  });

  it('labels dotted engine-block outcome paths with a friendly name', () => {
    expect(outcomeLabel('verdict')).toBe('verdict');
    expect(outcomeLabel('_engine_lifecycle.lifecycle_status')).toBe('lifecycle');
    expect(outcomeLabel('_engine_evidence.bug_status')).toBe('bug');
    expect(outcomeLabel('_engine_readiness.ready')).toBe('ready');
    expect(outcomeLabel('')).toBe('');
    const lifecycle = {
      ...graph,
      post: {
        ...graph.post,
        stages: [
          {
            ...graph.post.stages[3],
            outcomes: { '_engine_lifecycle.lifecycle_status': { impact_proven: 2, bug_blocked: 1 } },
          },
        ],
      },
    };
    const rendered = renderToStaticMarkup(<ScanGraph graph={lifecycle} />);
    expect(rendered).toContain('>lifecycle<');
    expect(rendered).toContain('title="_engine_lifecycle.lifecycle_status"');
    expect(rendered).toContain('impact_proven 2');
    expect(rendered).toContain('bug_blocked 1');
  });

  it('escapes untrusted step and script names', () => {
    const hostile = {
      ...graph,
      nodes: [{ ...graph.nodes[0], name: '<img src=x onerror=alert(1)>' }],
      edges: [],
      post: { ...graph.post, stages: [{ ...graph.post.stages[2], name: '<script>bad</script>' }] },
    };
    const rendered = renderToStaticMarkup(<ScanGraph graph={hostile} />);
    expect(rendered).not.toContain('<img src=x');
    expect(rendered).not.toContain('<script>');
  });
});

describe('ScanGraphPanel', () => {
  it('renders a labelled, collapsible section that starts by loading the graph', () => {
    const html = renderToStaticMarkup(<ScanGraphPanel scanId="9" active />);
    expect(html).toContain('<details');
    expect(html).toContain('open=""');
    expect(html).toContain('Scan graph');
    expect(html).toContain('Loading graph');
  });
});
