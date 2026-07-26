// A small, dependency-free Markdown renderer that produces React elements
// (so content is escaped — safe for untrusted report/PoC text). Supports the
// subset that security reports use: headings, paragraphs, bullet/ordered lists,
// fenced + inline code, bold/italic, links, blockquotes, and horizontal rules.

const HR_RE = /^\s*(?:---+|\*\*\*+|___+)\s*$/;
const BLOCK_START_RE = /^(?:#{1,6}\s|```|\s*>|\s*[-*+]\s+|\s*\d+\.\s+)|^\s*(?:---+|\*\*\*+|___+)\s*$/;

// Parse markdown into an array of block tokens. Exported for testing.
export function parseMarkdownBlocks(md) {
  const lines = String(md ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const lang = fence[1].trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: 'code', lang, text: buf.join('\n') });
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', text: buf.join('\n') });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !BLOCK_START_RE.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'p', text: buf.join('\n') });
  }
  return blocks;
}

const codeStyle = {
  fontFamily: "'Geist Mono', ui-monospace, monospace",
  fontSize: '0.86em',
  background: 'var(--surface-2)',
  border: '1px solid var(--border-2)',
  borderRadius: 4,
  padding: '1px 5px',
};
const linkStyle = { color: 'var(--accent)', textDecoration: 'underline' };

// Render inline markdown (code, bold, italic, links) within a text string.
function inline(text) {
  const out = [];
  let key = 0;
  for (const part of text.split(/(`[^`]+`)/g)) {
    if (/^`[^`]+`$/.test(part)) {
      out.push(
        <code key={key++} style={codeStyle}>
          {part.slice(1, -1)}
        </code>
      );
      continue;
    }
    const re = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
    let last = 0;
    let m;
    while ((m = re.exec(part))) {
      if (m.index > last) out.push(<span key={key++}>{part.slice(last, m.index)}</span>);
      const tok = m[0];
      if (tok.startsWith('**')) out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
      else if (tok.startsWith('[')) {
        const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        out.push(
          <a key={key++} href={lm[2]} target="_blank" rel="noreferrer" style={linkStyle}>
            {lm[1]}
          </a>
        );
      } else out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
      last = m.index + tok.length;
    }
    if (last < part.length) out.push(<span key={key++}>{part.slice(last)}</span>);
  }
  return out;
}

const HEADING_SIZE = { 1: 22, 2: 18, 3: 15.5, 4: 14, 5: 13, 6: 12.5 };

function renderBlock(block, i) {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${block.level}`;
      return (
        <Tag
          key={i}
          style={{
            fontSize: HEADING_SIZE[block.level],
            fontWeight: 600,
            lineHeight: 1.3,
            margin: i === 0 ? '0 0 12px' : '24px 0 12px',
            color: 'var(--text)',
          }}
        >
          {inline(block.text)}
        </Tag>
      );
    }
    case 'code':
      return (
        <pre
          key={i}
          style={{
            background: 'var(--code-bg)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '12px 14px',
            overflowX: 'auto',
            margin: '0 0 16px',
            fontSize: 12.5,
            lineHeight: 1.55,
          }}
        >
          <code style={{ fontFamily: "'Geist Mono', ui-monospace, monospace", color: 'var(--text)' }}>
            {block.text}
          </code>
        </pre>
      );
    case 'ul':
      return (
        <ul key={i} style={{ margin: '0 0 16px', paddingLeft: 22, lineHeight: 1.6 }}>
          {block.items.map((it, j) => (
            <li key={j} style={{ marginBottom: 4 }}>
              {inline(it)}
            </li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={i} style={{ margin: '0 0 16px', paddingLeft: 22, lineHeight: 1.6 }}>
          {block.items.map((it, j) => (
            <li key={j} style={{ marginBottom: 4 }}>
              {inline(it)}
            </li>
          ))}
        </ol>
      );
    case 'quote':
      return (
        <blockquote
          key={i}
          style={{
            margin: '0 0 16px',
            padding: '4px 14px',
            borderLeft: '3px solid var(--border)',
            color: 'var(--text-2)',
          }}
        >
          {block.text.split('\n').map((l, j) => (
            <div key={j}>{inline(l)}</div>
          ))}
        </blockquote>
      );
    case 'hr':
      return <hr key={i} style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '20px 0' }} />;
    default:
      return (
        <p key={i} style={{ margin: '0 0 14px', lineHeight: 1.65, color: 'var(--text)' }}>
          {block.text.split('\n').map((l, j) => (
            <span key={j}>
              {j > 0 && <br />}
              {inline(l)}
            </span>
          ))}
        </p>
      );
  }
}

export default function Markdown({ source, style }) {
  const blocks = parseMarkdownBlocks(source);
  return (
    <div style={{ fontSize: 13.5, color: 'var(--text)', ...style }}>
      {blocks.length ? (
        blocks.map(renderBlock)
      ) : (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>Nothing to display.</div>
      )}
    </div>
  );
}
