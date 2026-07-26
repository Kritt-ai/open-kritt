// Compute the pixel coordinates of a caret position inside a <textarea>, relative
// to the textarea's border box. Works by rendering an invisible mirror element
// that copies the textarea's text-layout styles and measuring a marker span.
// (The well-known "textarea-caret-position" technique.)

const COPY_PROPS = [
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontSizeAdjust',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
  'whiteSpace',
  'overflowWrap',
  'wordBreak',
];

export function getCaretCoordinates(el, position) {
  const computed = window.getComputedStyle(el);
  const div = document.createElement('div');

  COPY_PROPS.forEach((p) => {
    div.style[p] = computed[p];
  });

  // Use content-box sizing with an explicit content width so wrapping matches the
  // textarea regardless of its box-sizing.
  const padL = parseFloat(computed.paddingLeft) || 0;
  const padR = parseFloat(computed.paddingRight) || 0;
  const contentWidth = el.clientWidth - padL - padR;

  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.boxSizing = 'content-box';
  div.style.width = `${contentWidth}px`;
  div.style.whiteSpace = 'pre-wrap';
  div.style.overflowWrap = 'break-word';
  div.style.overflow = 'hidden';
  div.style.top = '0';
  div.style.left = '0';

  document.body.appendChild(div);
  div.textContent = el.value.slice(0, position);
  const span = document.createElement('span');
  span.textContent = el.value.slice(position) || '.';
  div.appendChild(span);

  const top = span.offsetTop + (parseFloat(computed.borderTopWidth) || 0);
  const left = span.offsetLeft + (parseFloat(computed.borderLeftWidth) || 0);
  document.body.removeChild(div);

  return { top, left, lineHeight: parseFloat(computed.lineHeight) || (parseFloat(computed.fontSize) || 13) * 1.7 };
}
