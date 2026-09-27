// Live stage graph for one scan: one SVG node per workflow step, edges labelled
// with the lineages that flowed between steps, and the post-processing funnel
// underneath. Pure layout math is exported so it can be unit tested; the
// component draws inline SVG with no charting dependency.

import { useState } from 'react';
import { api } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 84;
const COLUMN_GAP = 84;
const ROW_GAP = 16;
const PADDING = 12;
const DEPTH_PALETTE_SIZE = 6;
const ATTEMPT_ORDER = ['completed', 'running', 'failed', 'interrupted', 'stopped'];
const ATTEMPT_COLORS = {
  completed: 'var(--ok)',
  running: 'var(--run)',
  failed: 'var(--fail)',
  interrupted: 'var(--pend)',
  stopped: 'var(--text-3)',
};

const depthColor = (depth) => `var(--depth-${(Number(depth) || 0) % DEPTH_PALETTE_SIZE})`;

// Funnel outcome keys are the result fields the backend bucketed. Plain keys
// ("verdict") render as-is; a dotted path into an engine block
// ("_engine_lifecycle.lifecycle_status") renders as its friendly last segment
// ("lifecycle") so the funnel reads "lifecycle impact_proven 3".
export function outcomeLabel(key) {
  const name = String(key ?? '');
  if (!name.includes('.')) return name;
  const leaf = name.split('.').filter(Boolean).pop() || name;
  return leaf.replace(/^_engine_/, '').replace(/_status$/, '') || leaf;
}
const count = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const plural = (value, singular, pluralForm = `${singular}s`) => `${value} ${value === 1 ? singular : pluralForm}`;

export function layoutScanGraph(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const depths = [...new Set(nodes.map((node) => Number(node.depth) || 0))].sort((a, b) => a - b);
  const rows = Math.max(1, ...depths.map((depth) => nodes.filter((node) => Number(node.depth) === depth).length));
  const height = PADDING * 2 + rows * NODE_HEIGHT + (rows - 1) * ROW_GAP;
  const columns = depths.map((depth, index) => ({ depth, x: PADDING + index * (NODE_WIDTH + COLUMN_GAP) }));
  const columnX = new Map(columns.map((column) => [column.depth, column.x]));

  const placed = [];
  for (const depth of depths) {
    const siblings = nodes.filter((node) => Number(node.depth) === depth);
    const stackHeight = siblings.length * NODE_HEIGHT + (siblings.length - 1) * ROW_GAP;
    const top = PADDING + (height - PADDING * 2 - stackHeight) / 2;
    siblings.forEach((node, index) => {
      placed.push({
        ...node,
        x: columnX.get(depth),
        y: top + index * (NODE_HEIGHT + ROW_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    });
  }
  const byId = new Map(placed.map((node) => [node.id, node]));
  const placedEdges = edges
    .map((edge) => {
      const source = byId.get(edge.from);
      const target = byId.get(edge.to);
      if (!source || !target) return null;
      const x1 = source.x + source.width;
      const y1 = source.y + source.height / 2;
      const x2 = target.x;
      const y2 = target.y + target.height / 2;
      const bend = (x2 - x1) / 2;
      return {
        ...edge,
        x1,
        y1,
        x2,
        y2,
        path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
        labelX: (x1 + x2) / 2,
        labelY: (y1 + y2) / 2 - 6,
      };
    })
    .filter(Boolean);

  const width = columns.length ? columns[columns.length - 1].x + NODE_WIDTH + PADDING : PADDING * 2 + NODE_WIDTH;
  return { width, height, columns, nodes: placed, edges: placedEdges };
}

function nodeDescription(node) {
  const attempts = node.attempts || {};
  const completed = count(attempts.completed);
  const parts = [`${completed} of ${count(node.expected)} lineages completed`];
  for (const status of ATTEMPT_ORDER.slice(1))
    if (count(attempts[status])) parts.push(`${count(attempts[status])} ${status}`);
  if (count(node.stubs)) parts.push(plural(count(node.stubs), 'stub'));
  parts.push(plural(count(node.records), node.isLastStep ? 'finding' : 'record'));
  return `Depth ${count(node.depth)} step ${node.name}: ${parts.join(', ')}`;
}

// "33 done · 3 running · 2 failed": every non-zero attempt status, in order.
function attemptStatusParts(attempts) {
  const labels = {
    completed: 'done',
    running: 'running',
    failed: 'failed',
    interrupted: 'interrupted',
    stopped: 'stopped',
  };
  return ATTEMPT_ORDER.filter((status) => count(attempts?.[status])).map((status) => ({
    status,
    text: `${count(attempts[status])} ${labels[status]}`,
    color: ATTEMPT_COLORS[status],
  }));
}

function AttemptBar({ attempts, expected, width }) {
  const total = Math.max(
    count(expected),
    ATTEMPT_ORDER.reduce((sum, status) => sum + count(attempts?.[status]), 0),
    1
  );
  let offset = 0;
  return (
    <g>
      <rect x={0} y={0} width={width} height={5} rx={2.5} fill="var(--surface-2)" />
      {ATTEMPT_ORDER.map((status) => {
        const value = count(attempts?.[status]);
        if (!value) return null;
        const segment = (value / total) * width;
        const x = offset;
        offset += segment;
        return <rect key={status} x={x} y={0} width={segment} height={5} rx={2.5} fill={ATTEMPT_COLORS[status]} />;
      })}
    </g>
  );
}

function StepNode({ node, selected, onSelect }) {
  const attempts = node.attempts || {};
  const summary = `${count(attempts.completed)}/${count(node.expected)}`;
  const records = plural(count(node.records), node.isLastStep ? 'finding' : 'record');
  const statusParts = attemptStatusParts(attempts).filter((part) => part.status !== 'completed');
  return (
    <g
      transform={`translate(${node.x} ${node.y})`}
      role={onSelect ? 'button' : 'group'}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={nodeDescription(node)}
      data-step-id={node.stepId}
      data-selected={selected ? 'true' : 'false'}
      onClick={onSelect ? () => onSelect(node.stepId) : undefined}
      onKeyDown={
        onSelect
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(node.stepId);
              }
            }
          : undefined
      }
      style={{ cursor: onSelect ? 'pointer' : 'default' }}
    >
      <title>{nodeDescription(node)}</title>
      <defs>
        <clipPath id={`scan-graph-node-${node.stepId}`}>
          <rect width={node.width - 8} height={node.height} />
        </clipPath>
      </defs>
      <rect
        width={node.width}
        height={node.height}
        rx={9}
        fill="var(--surface)"
        stroke={selected ? 'var(--accent)' : 'var(--border)'}
        strokeWidth={selected ? 1.5 : 1}
      />
      <rect x={0} y={0} width={4} height={node.height} rx={2} fill={depthColor(node.depth)} />
      <text x={14} y={19} fontSize={12} fontWeight={600} fill="var(--text)">
        {node.name.length > 24 ? `${node.name.slice(0, 23)}…` : node.name}
      </text>
      <text x={node.width - 12} y={19} fontSize={10.5} textAnchor="end" fill="var(--text-2)" className="mono">
        {summary}
      </text>
      <g transform="translate(14 29)">
        <AttemptBar attempts={attempts} expected={node.expected} width={node.width - 26} />
      </g>
      <text x={14} y={52} fontSize={10.5} fill="var(--text-2)" className="mono">
        {records}
        {count(node.stubs) ? ` · ${plural(count(node.stubs), 'stub')}` : ''}
      </text>
      <text x={14} y={69} fontSize={10.5} className="mono" clipPath={`url(#scan-graph-node-${node.stepId})`}>
        {statusParts.map((part, index) => (
          <tspan key={part.text} fill={part.color}>
            {index ? ' · ' : ''}
            {part.text}
          </tspan>
        ))}
      </text>
    </g>
  );
}

function Edge({ edge, sourceName, targetName }) {
  const owed = count(edge.expected) > count(edge.lineages);
  return (
    <g aria-label={`${sourceName} to ${targetName}: ${count(edge.lineages)} of ${count(edge.expected)} lineages`}>
      <path
        d={edge.path}
        fill="none"
        stroke={owed ? 'var(--pend)' : 'var(--border)'}
        strokeWidth={1.25}
        strokeDasharray={owed ? '4 3' : undefined}
      />
      <text x={edge.labelX} y={edge.labelY} fontSize={10} textAnchor="middle" fill="var(--text-3)" className="mono">
        {`${count(edge.lineages)}/${count(edge.expected)}`}
      </text>
    </g>
  );
}

function FunnelStage({ stage }) {
  const statusParts = attemptStatusParts(stage.attempts);
  const outcomeGroups = Object.entries(stage.outcomes || {}).filter(
    ([, values]) => values && Object.keys(values).length
  );
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 9,
        background: 'var(--surface)',
        padding: '9px 12px',
        minWidth: 150,
        flex: '1 1 150px',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }} title={stage.name}>
          {stage.name}
        </span>
        <span className="mono" style={{ fontSize: 10.5 }}>
          {statusParts.length ? (
            statusParts.map((part, index) => (
              <span key={part.status} style={{ color: part.color }}>
                {index ? ' · ' : ''}
                {part.text}
              </span>
            ))
          ) : (
            <span style={{ color: 'var(--text-3)' }}>pending</span>
          )}
        </span>
      </div>
      {stage.kind === 'post_script' && (
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-2)', marginTop: 5 }}>
          {plural(count(stage.enrichments), 'result')}
          {count(stage.stubs) ? ` · ${plural(count(stage.stubs), 'stub')}` : ''}
        </div>
      )}
      {outcomeGroups.map(([key, values]) => (
        <div key={key} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5, marginTop: 6 }}>
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-3)' }} title={key}>
            {outcomeLabel(key)}
          </span>
          {Object.entries(values).map(([label, value]) => (
            <span
              key={label}
              className="mono"
              style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 5,
                background: 'var(--surface-2)',
                color: 'var(--text-2)',
              }}
            >
              {`${label} ${value}`}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

function Funnel({ post }) {
  const stages = Array.isArray(post?.stages) ? post.stages : [];
  return (
    <div style={{ marginTop: 14 }}>
      <div
        className="mono"
        style={{ fontSize: 10, letterSpacing: '0.05em', color: 'var(--text-3)', textTransform: 'uppercase' }}
      >
        Post-processing
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start', marginTop: 7 }}>
        <div
          className="mono"
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 3,
            fontSize: 11,
            color: 'var(--text-2)',
            padding: '9px 12px',
            border: '1px solid var(--border)',
            borderRadius: 9,
            background: 'var(--surface-2)',
          }}
        >
          <span>{`${count(post?.rawFindings)} raw`}</span>
          <span style={{ color: 'var(--text)' }}>{`${count(post?.canonicalFindings)} canonical`}</span>
          <span>{`${count(post?.duplicateFindings)} duplicate`}</span>
        </div>
        {stages.map((stage) => (
          <FunnelStage key={stage.id} stage={stage} />
        ))}
      </div>
    </div>
  );
}

export default function ScanGraph({ graph, selectedStepId = null, onSelectStep }) {
  const layout = layoutScanGraph(graph);
  const names = new Map(layout.nodes.map((node) => [node.id, node.name]));
  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label="Workflow step graph"
          style={{ display: 'block', minWidth: layout.width }}
        >
          {layout.columns.map((column) => (
            <text
              key={column.depth}
              x={column.x + NODE_WIDTH / 2}
              y={9}
              fontSize={9.5}
              textAnchor="middle"
              fill={depthColor(column.depth)}
              className="mono"
            >
              {`D${column.depth}`}
            </text>
          ))}
          {layout.edges.map((edge) => (
            <Edge
              key={`${edge.from}-${edge.to}`}
              edge={edge}
              sourceName={names.get(edge.from)}
              targetName={names.get(edge.to)}
            />
          ))}
          {layout.nodes.map((node) => (
            <StepNode
              key={node.id}
              node={node}
              selected={selectedStepId != null && String(selectedStepId) === String(node.stepId)}
              onSelect={onSelectStep}
            />
          ))}
        </svg>
      </div>
      <Funnel post={graph?.post} />
    </div>
  );
}

const GRAPH_POLL_MS = 2000;

// Collapsible section for the scan page. Polls while the scan is active so the
// counts move with the workers; a finished scan loads the graph once.
export function ScanGraphPanel({ scanId, active = false }) {
  const [selectedStepId, setSelectedStepId] = useState(null);
  const {
    data: graph,
    loading,
    error,
    reload,
  } = useFetch(() => api.scanGraph(scanId), [scanId], { pollMs: active ? GRAPH_POLL_MS : 0 });
  return (
    <details
      open
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '13px 15px',
        background: 'var(--surface)',
        marginBottom: 24,
      }}
    >
      <summary
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.05em',
          color: 'var(--text-3)',
          textTransform: 'uppercase',
          cursor: 'pointer',
          listStyle: 'none',
          display: 'flex',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <span>Scan graph</span>
        <span style={{ textTransform: 'none', letterSpacing: 0 }}>{active ? 'live' : graph ? 'final' : ''}</span>
      </summary>
      <div style={{ marginTop: 10 }}>
        {loading && !graph && <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>Loading graph…</div>}
        {error && !graph && (
          <div style={{ fontSize: 12.5, color: 'var(--fail)', display: 'flex', gap: 10, alignItems: 'center' }}>
            <span>Could not load the scan graph.</span>
            <button
              type="button"
              onClick={reload}
              style={{
                font: 'inherit',
                fontSize: 12,
                color: 'var(--text-2)',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '2px 9px',
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
          </div>
        )}
        {graph && (
          <ScanGraph
            graph={graph}
            selectedStepId={selectedStepId}
            onSelectStep={(stepId) => setSelectedStepId((current) => (current === stepId ? null : stepId))}
          />
        )}
      </div>
    </details>
  );
}
