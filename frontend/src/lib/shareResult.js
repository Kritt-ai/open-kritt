export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 630;
export const SHARE_IMAGE_FILENAME = 'open-kritt-security-finding.png';
export const X_HANDLE = '@Kritt_AI';
export const X_DESTINATION = 'https://kritt.ai/';
export const GITHUB_DESTINATION = 'https://github.com/Kritt-ai/open-kritt';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const SEVERITY_LABELS = Object.fromEntries(SEVERITY_ORDER.map((severity) => [severity, capitalize(severity)]));

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function normalizeShareSeverity(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return Object.hasOwn(SEVERITY_LABELS, normalized) ? normalized : null;
}

export function buildShareArtifact({ channel = 'elsewhere', includeSeverity = false, severity = null } = {}) {
  const safeChannel = channel === 'x' ? 'x' : 'elsewhere';
  const safeSeverity = includeSeverity ? normalizeShareSeverity(severity) : null;
  const qualifier = safeSeverity ? `${SEVERITY_LABELS[safeSeverity]} ` : '';
  const cardText = `I found a ${qualifier}vulnerability using open·kritt.`;
  const caption =
    safeChannel === 'x'
      ? `${cardText} Built with ${X_HANDLE}.\n\n${X_DESTINATION}`
      : `${cardText}\n\nOpen source: ${GITHUB_DESTINATION}`;

  return Object.freeze({
    channel: safeChannel,
    severity: safeSeverity,
    cardText,
    caption,
  });
}

export function buildCommunityShareArtifact({ channel = 'elsewhere' } = {}) {
  const safeChannel = channel === 'x' ? 'x' : 'elsewhere';
  const cardText = 'Open-source security is stronger when we build together.';
  const caption =
    safeChannel === 'x'
      ? `Open-source security is stronger when we build together. Support ${X_HANDLE} and share open·kritt.\n\n${X_DESTINATION}`
      : `Open-source security is stronger when we build together. Support and share open·kritt.\n\n${GITHUB_DESTINATION}`;

  return Object.freeze({
    channel: safeChannel,
    severity: null,
    cardText,
    caption,
  });
}

let logoPromise = null;

function loadShareLogo() {
  if (logoPromise) return logoPromise;
  logoPromise = new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      reject(new Error('Image generation is unavailable in this browser.'));
      return;
    }
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The open·kritt logo could not be loaded.'));
    image.src = '/apple-touch-icon.png';
  });
  return logoPromise;
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function wrapCanvasText(context, text, x, y, maxWidth, lineHeight) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && context.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  lines.forEach((value, index) => context.fillText(value, x, y + index * lineHeight));
  return lines.length;
}

export async function renderShareCard(canvas, artifact) {
  const context = canvas?.getContext?.('2d');
  if (!context) throw new Error('Image generation is unavailable in this browser.');
  const logo = await loadShareLogo();

  canvas.width = SHARE_CARD_WIDTH;
  canvas.height = SHARE_CARD_HEIGHT;

  const gradient = context.createLinearGradient(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);
  gradient.addColorStop(0, '#fffaf7');
  gradient.addColorStop(1, '#f6f5f2');
  context.fillStyle = gradient;
  context.fillRect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);

  context.fillStyle = '#ff5c3d';
  context.beginPath();
  context.arc(1138, 56, 190, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = 0.12;
  context.beginPath();
  context.arc(1088, 602, 255, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = 1;

  context.save();
  roundedRect(context, 64, 48, 112, 112, 24);
  context.clip();
  context.drawImage(logo, 64, 48, 112, 112);
  context.restore();

  context.fillStyle = '#1a1a18';
  context.font = "600 43px 'Geist', Arial, sans-serif";
  context.textBaseline = 'alphabetic';
  context.fillText('open', 198, 118);
  const openWidth = context.measureText('open').width;
  context.fillStyle = '#ff5c3d';
  context.fillText('·', 198 + openWidth, 118);
  const dotWidth = context.measureText('·').width;
  context.fillStyle = '#1a1a18';
  context.fillText('kritt', 198 + openWidth + dotWidth, 118);

  context.fillStyle = '#1a1a18';
  context.font = "700 66px 'Geist', Arial, sans-serif";
  const lineCount = wrapCanvasText(context, artifact.cardText, 70, 276, 1015, 82);

  const supportingY = 276 + lineCount * 82 + 34;
  context.fillStyle = '#6b6b66';
  context.font = "400 27px 'Geist', Arial, sans-serif";
  context.fillText('AI-driven security research. Open source.', 72, Math.min(supportingY, 488));

  context.strokeStyle = '#deddd9';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(72, 542);
  context.lineTo(1128, 542);
  context.stroke();

  context.fillStyle = '#fff0ec';
  roundedRect(context, 72, 565, 166, 36, 18);
  context.fill();
  context.fillStyle = '#d74228';
  context.font = "700 16px 'Geist', Arial, sans-serif";
  context.fillText('OPEN SOURCE', 91, 589);

  context.fillStyle = '#6b6b66';
  context.font = "500 21px 'Geist', Arial, sans-serif";
  context.textAlign = 'right';
  context.fillText('kritt.ai', 1128, 590);
  context.textAlign = 'left';
}

export function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The share image could not be generated.'));
    }, 'image/png');
  });
}

export function xIntentUrl(caption) {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(caption)}`;
}

function canShareFile(navigatorObject, file) {
  if (!file || typeof navigatorObject?.share !== 'function' || typeof navigatorObject?.canShare !== 'function') {
    return false;
  }
  try {
    return navigatorObject.canShare({ files: [file] }) === true;
  } catch {
    return false;
  }
}

export async function shareWithChannel({
  artifact,
  file,
  blob = file,
  navigatorObject = globalThis.navigator,
  downloadFile = downloadShareBlob,
  openWindow = (url) => globalThis.window?.open?.(url, '_blank', 'noopener,noreferrer'),
}) {
  // The Web Share API cannot target a specific app. If we use it for X, Chrome
  // may open the operating-system share sheet without X as an available target.
  // Open the composer directly and download the image for manual attachment so
  // this action behaves consistently across browsers and operating systems.
  if (artifact.channel === 'x') {
    openWindow(xIntentUrl(artifact.caption));
    downloadFile(blob, SHARE_IMAGE_FILENAME);
    return { kind: 'x-fallback' };
  }

  if (canShareFile(navigatorObject, file)) {
    await navigatorObject.share({
      title: 'open·kritt security finding',
      text: artifact.caption,
      files: [file],
    });
    return { kind: 'file-shared' };
  }

  if (typeof navigatorObject?.share === 'function') {
    await navigatorObject.share({
      title: 'open·kritt security finding',
      text: artifact.caption,
    });
    return { kind: 'text-shared' };
  }

  return { kind: 'unsupported' };
}

export function downloadShareBlob(blob, filename = SHARE_IMAGE_FILENAME) {
  if (!blob) throw new Error('The share image is not ready yet.');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function copyShareText(
  text,
  { navigatorObject = globalThis.navigator, documentObject = globalThis.document } = {}
) {
  if (typeof navigatorObject?.clipboard?.writeText === 'function') {
    await navigatorObject.clipboard.writeText(text);
    return;
  }
  if (!documentObject?.body || typeof documentObject.execCommand !== 'function') {
    throw new Error('Clipboard access is unavailable in this browser.');
  }

  const textarea = documentObject.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  documentObject.body.appendChild(textarea);
  textarea.select();
  const copied = documentObject.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('The post could not be copied.');
}
