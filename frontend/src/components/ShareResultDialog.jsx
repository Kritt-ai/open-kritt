import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './ui.jsx';
import { useModalDialog } from '../lib/useModalDialog.js';
import {
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  SHARE_IMAGE_FILENAME,
  buildCommunityShareArtifact,
  buildShareArtifact,
  canvasToPngBlob,
  copyShareText,
  downloadShareBlob,
  renderShareCard,
  shareWithChannel,
} from '../lib/shareResult.js';

function shareFile(blob) {
  if (!blob || typeof File === 'undefined') return null;
  return new File([blob], SHARE_IMAGE_FILENAME, { type: 'image/png' });
}

export default function ShareResultDialog({ severity = null, automatic = false, mode = 'result', onClose }) {
  const communityMode = mode === 'community';
  const [includeSeverity, setIncludeSeverity] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [imageBlob, setImageBlob] = useState(null);
  const [imageError, setImageError] = useState(null);
  const [busyAction, setBusyAction] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const canvasRef = useRef(null);

  const closeDialog = () => onClose({ disableAutomaticPrompts: automatic && dontShowAgain });
  const dialogRef = useModalDialog(closeDialog);
  const cardArtifact = useMemo(
    () => (communityMode ? buildCommunityShareArtifact() : buildShareArtifact({ includeSeverity, severity })),
    [communityMode, includeSeverity, severity]
  );
  const xArtifact = useMemo(
    () =>
      communityMode
        ? buildCommunityShareArtifact({ channel: 'x' })
        : buildShareArtifact({ includeSeverity, severity, channel: 'x' }),
    [communityMode, includeSeverity, severity]
  );
  const elsewhereArtifact = useMemo(
    () =>
      communityMode
        ? buildCommunityShareArtifact({ channel: 'elsewhere' })
        : buildShareArtifact({ includeSeverity, severity, channel: 'elsewhere' }),
    [communityMode, includeSeverity, severity]
  );

  useEffect(() => {
    let active = true;
    setImageBlob(null);
    setImageError(null);
    setFeedback(null);
    Promise.resolve()
      .then(() => renderShareCard(canvasRef.current, cardArtifact))
      .then(() => canvasToPngBlob(canvasRef.current))
      .then((blob) => {
        if (active) setImageBlob(blob);
      })
      .catch((error) => {
        if (active) setImageError(error);
      });
    return () => {
      active = false;
    };
  }, [cardArtifact]);

  const runAction = async (name, action) => {
    if (!imageBlob || busyAction) return;
    setBusyAction(name);
    setFeedback(null);
    try {
      await action();
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setFeedback({ tone: 'error', message: error?.message || 'Sharing failed. Please try again.' });
      }
    } finally {
      setBusyAction(null);
    }
  };

  const shareOnX = () =>
    runAction('x', async () => {
      const result = await shareWithChannel({
        artifact: xArtifact,
        file: shareFile(imageBlob),
        blob: imageBlob,
      });
      setFeedback(
        result.kind === 'x-fallback'
          ? {
              tone: 'success',
              message: 'The PNG was downloaded. Attach it to the prefilled X post that just opened.',
            }
          : { tone: 'success', message: 'The X-ready image and @Kritt_AI caption were sent to your share sheet.' }
      );
    });

  const shareElsewhere = () =>
    runAction('elsewhere', async () => {
      const result = await shareWithChannel({
        artifact: elsewhereArtifact,
        file: shareFile(imageBlob),
        blob: imageBlob,
      });
      if (result.kind === 'unsupported') {
        await copyShareText(elsewhereArtifact.caption);
        setFeedback({
          tone: 'success',
          message: 'Native sharing is unavailable, so the GitHub-linked post was copied instead.',
        });
      } else if (result.kind === 'text-shared') {
        setFeedback({
          tone: 'success',
          message: 'The GitHub-linked post was sent to your share sheet. You can download the PNG separately.',
        });
      } else {
        setFeedback({ tone: 'success', message: 'The image and GitHub-linked post were sent to your share sheet.' });
      }
    });

  const copyPost = () =>
    runAction('copy', async () => {
      await copyShareText(elsewhereArtifact.caption);
      setFeedback({ tone: 'success', message: 'Post copied with the open·kritt GitHub link.' });
    });

  const downloadImage = () =>
    runAction('download', async () => {
      downloadShareBlob(imageBlob);
      setFeedback({ tone: 'success', message: 'PNG downloaded.' });
    });

  const imageReady = Boolean(imageBlob) && !imageError;

  return (
    <div className="share-result-backdrop" role="presentation" onMouseDown={closeDialog}>
      <div
        ref={dialogRef}
        className="share-result-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-result-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="share-result-header">
          <div>
            <div id="share-result-title" className="share-result-title">
              It’s open source. Give back to the community.
            </div>
            <div className="share-result-subtitle">
              {communityMode
                ? 'Help more security researchers discover, use, and improve open·kritt.'
                : 'Share what open·kritt helped you accomplish—never the classified vulnerability details.'}
            </div>
          </div>
          <button type="button" className="share-result-close" aria-label="Close share dialog" onClick={closeDialog}>
            ×
          </button>
        </div>

        <div className="share-result-body">
          <canvas
            ref={canvasRef}
            className="share-result-preview"
            width={SHARE_CARD_WIDTH}
            height={SHARE_CARD_HEIGHT}
            role="img"
            aria-label={`Share-card preview: ${cardArtifact.cardText}`}
          />

          {!communityMode && severity && (
            <label className="share-result-option">
              <input
                type="checkbox"
                checked={includeSeverity}
                onChange={(event) => setIncludeSeverity(event.target.checked)}
              />
              <span>
                <strong>Include highest severity</strong>
                <small>This reveals only the normalized severity shown in the preview.</small>
              </span>
            </label>
          )}

          <div className="share-result-privacy-note">
            {communityMode ? (
              <>This shares only open·kritt branding and project links. No scan or vulnerability data is included.</>
            ) : (
              <>
                No repository, finding title, path, code, report, PoC, model, scan ID, count, or timestamp is included.
                Sharing open·kritt—not the vulnerability details—is the safe way to contribute back.
              </>
            )}
          </div>

          {imageError && (
            <div className="share-result-feedback share-result-feedback-error" role="alert">
              {imageError.message}
            </div>
          )}
          {feedback && (
            <div
              className={`share-result-feedback ${
                feedback.tone === 'error' ? 'share-result-feedback-error' : 'share-result-feedback-success'
              }`}
              role={feedback.tone === 'error' ? 'alert' : 'status'}
              aria-live="polite"
            >
              {feedback.message}
            </div>
          )}

          <div className="share-result-actions">
            <div className="share-result-channel-actions">
              <Button data-autofocus disabled={!imageReady || Boolean(busyAction)} onClick={shareOnX}>
                {busyAction === 'x' ? 'Sharing…' : 'Share on X'}
              </Button>
              <Button variant="subtle" disabled={!imageReady || Boolean(busyAction)} onClick={shareElsewhere}>
                {busyAction === 'elsewhere' ? 'Sharing…' : 'Share elsewhere'}
              </Button>
            </div>
            <div className="share-result-secondary-actions">
              <Button variant="ghost" disabled={!imageReady || Boolean(busyAction)} onClick={copyPost}>
                {busyAction === 'copy' ? 'Copying…' : 'Copy post'}
              </Button>
              <Button variant="ghost" disabled={!imageReady || Boolean(busyAction)} onClick={downloadImage}>
                {busyAction === 'download' ? 'Downloading…' : 'Download PNG'}
              </Button>
            </div>
          </div>

          {!communityMode && automatic && (
            <label className="share-result-dont-show">
              <input
                type="checkbox"
                checked={dontShowAgain}
                onChange={(event) => setDontShowAgain(event.target.checked)}
              />
              Don’t show this automatically again
            </label>
          )}
        </div>
      </div>
    </div>
  );
}
