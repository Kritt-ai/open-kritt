// The Kritt mark. Rendered as a CSS mask over the real logo art
// (public/logo-mask.png) so it takes on any color — pass `color` (defaults to
// the inherited text color) and it adapts to the active theme.
export default function Logo({ size = 22, color = 'currentColor', title = 'Kritt', style, ...rest }) {
  const mask = 'url(/logo-mask.png) center / contain no-repeat';
  return (
    <span
      role="img"
      aria-label={title}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        flex: 'none',
        backgroundColor: color,
        WebkitMask: mask,
        mask,
        ...style,
      }}
      {...rest}
    />
  );
}
