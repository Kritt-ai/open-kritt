const URL_PATTERN = /(https?:\/\/[^\s]+)/g;

export default function LinkifiedText({ text }) {
  const value = String(text || '');
  if (!value) return null;

  return value.split(URL_PATTERN).map((part, index) => {
    if (!part.match(URL_PATTERN)) return <span key={index}>{part}</span>;
    return (
      <a
        key={index}
        href={part}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
        style={{ color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: 2 }}
      >
        {part}
      </a>
    );
  });
}
