import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
import { CardLinkOverlay, Spinner, ErrorState, StatusBadge, Button } from '../components/ui.jsx';
import LinkifiedText from '../components/LinkifiedText.jsx';
import {
  sevColor,
  findingSeverity,
  providerCapacityAutoscalePresentation,
  rateLimitPresentation,
  rateLimitRetryText,
  storageWarningPresentation,
} from '../lib/format.js';
import { isScanDeletable, postOutputSummary } from '../lib/scanPresentation.js';
import { configuredModelCatalog, configuredModelProviders } from '../lib/modelProviders.js';
import { createLatestFieldMutationQueue } from '../lib/latestMutation.js';
import { duplicateScanPath } from '../lib/scanDuplication.js';
import { useUnsavedChangesPrompt } from '../lib/useUnsavedChangesPrompt.js';
import WorkflowModelConfiguration, {
  workflowModelConfigurationForCatalog,
  workflowModelConfigurationIsValid,
} from '../components/WorkflowModelConfiguration.jsx';
import { modelOverridesDraft, modelOverridesEqual, reconcileModelOverrides } from '../lib/modelOverrides.js';
import { usePagination } from '../lib/usePagination.js';
import Pagination from '../components/Pagination.jsx';
import ShareResultDialog from '../components/ShareResultDialog.jsx';
import { canShareScanResult, highestShareSeverity, sharePromptStore } from '../lib/shareResult.js';

export function scanActions(status) {
  const active = ['prewarming_cache', 'running', 'post_processing'].includes(status);
  return {
    canPause: active,
    canResume: ['paused', 'failed', 'stopped'].includes(status),
    canStop: ['queued', 'pending', 'prewarming_cache', 'running', 'rate_limited', 'paused', 'post_processing'].includes(
      status
    ),
    canDelete: isScanDeletable(status),
    stopLabel: ['queued', 'pending'].includes(status) ? 'Cancel' : status === 'rate_limited' ? 'Stop retrying' : 'Stop',
  };
}

export async function loadModelReferences(fetchProviders, fetchCatalog) {
  const [providerPayload, catalogResult] = await Promise.all([
    Promise.resolve().then(fetchProviders),
    Promise.resolve()
      .then(fetchCatalog)
      .then(
        (catalog) => ({ catalog, error: null }),
        (error) => ({ catalog: null, error })
      ),
  ]);
  return {
    providers: configuredModelProviders(providerPayload),
    catalog: configuredModelCatalog(catalogResult.catalog),
    catalogError: catalogResult.error,
  };
}

export default function ScanDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [reviewError, setReviewError] = useState(null);
  const [shareDialog, setShareDialog] = useState(null);
  const reviewMutations = useRef(createLatestFieldMutationQueue());
  const { data: scan, loading, error, reload } = useFetch(() => api.scan(id), [id], { pollMs: 1000 });
  const {
    data: vulns,
    loading: vulnsLoading,
    error: vulnsError,
    reload: reloadVulns,
    setData: setVulns,
  } = useFetch(
    () => api.scanVulnerabilities(id).then((records) => reviewMutations.current.overlayRecords(records)),
    [id],
    { pollMs: 1000 }
  );
  const {
    data: modelReferences,
    loading: modelReferencesLoading,
    error: modelReferencesError,
    reload: reloadModelReferences,
  } = useFetch(
    () =>
      loadModelReferences(
        () => api.modelProviders(),
        () => api.modelCatalog()
      ),
    [],
    { pollMs: 5000 }
  );

  useEffect(() => {
    reviewMutations.current.dispose();
    const queue = createLatestFieldMutationQueue();
    reviewMutations.current = queue;
    setReviewError(null);
    return () => queue.dispose();
  }, [id]);

  useEffect(() => setShareDialog(null), [id]);

  const shareFindingsLoaded = scan?.id === id && Array.isArray(vulns) && !vulnsLoading && !vulnsError;
  const shareEligible = canShareScanResult({
    status: scan?.status,
    findingsLoaded: shareFindingsLoaded,
    findingCount: vulns?.length || 0,
  });
  const shareRequested = searchParams.get('share') === 'result';

  useEffect(() => {
    if (!shareEligible) return;
    if (shareRequested) {
      setShareDialog({ automatic: false });
      return;
    }
    const shouldPrompt = sharePromptStore.evaluate({
      scanId: id,
      status: scan.status,
      findingsLoaded: shareFindingsLoaded,
      findingCount: vulns.length,
    });
    if (shouldPrompt) setShareDialog({ automatic: true });
  }, [id, scan?.status, shareEligible, shareFindingsLoaded, shareRequested, vulns?.length]);

  const findingPages = usePagination(vulns || [], { pageSize: 20, resetKey: id });

  const closeShareDialog = ({ disableAutomaticPrompts = false } = {}) => {
    if (disableAutomaticPrompts) sharePromptStore.disableAutomaticPrompts();
    setShareDialog(null);
  };

  const setStatus = async (status) => {
    setBusy(true);
    setActionError(null);
    try {
      await api.updateScanStatus(id, status);
      reload();
    } catch (statusError) {
      setActionError(statusError);
    } finally {
      setBusy(false);
    }
  };

  const saveRunSettings = async (settings) => {
    await api.updateScan(id, settings);
    reload();
  };

  const deleteScan = async () => {
    const confirmed = window.confirm(
      'Permanently delete this scan and all findings, attempts, logs, and review data? This cannot be undone.'
    );
    if (!confirmed) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.deleteScan(id);
      navigate('/scans', { replace: true });
    } catch (deleteError) {
      setActionError(deleteError);
      setBusy(false);
    }
  };

  // Optimistically update review fields. Per-record queues ensure rapid clicks
  // reach the server in order, and pending overlays survive background polls.
  const saveVuln = (vuln, patch) => {
    const fields = Object.keys(patch);
    setReviewError(null);
    setVulns((prev) => (prev || []).map((item) => (item.id === vuln.id ? { ...item, ...patch } : item)));
    for (const field of fields) {
      const value = patch[field];
      reviewMutations.current.enqueue({
        scope: vuln.id,
        field,
        value,
        mutate: () => api.updateVulnerability(vuln.id, { [field]: value }),
        onSuccess: (saved) => {
          if (!saved) return;
          setVulns((prev) =>
            (prev || []).map((item) => (item.id === vuln.id ? { ...item, [field]: saved[field] } : item))
          );
        },
        onError: (saveError) => {
          setReviewError(saveError);
          reloadVulns();
        },
      });
    }
  };
  const cycleInteresting = (v, e) => {
    e.stopPropagation();
    const cur = v.interesting ?? null;
    const next = cur === null ? 1 : cur === 1 ? 0 : null;
    saveVuln(v, { interesting: next });
  };

  usePageChrome(
    [
      { label: 'Scans', to: '/scans' },
      { label: scan?.repoDisplay || scan?.repoFull || '…', active: true },
    ],
    null,
    [scan?.repoDisplay]
  );

  if (loading)
    return (
      <div style={{ padding: 26 }}>
        <Spinner />
      </div>
    );
  if (error)
    return (
      <div style={{ padding: 26 }}>
        <ErrorState error={error} onRetry={reload} />
      </div>
    );
  if (!scan) return null;

  const list = vulns || [];
  const shareSeverity = highestShareSeverity(list.map(findingSeverity));
  const extraEntries = scan.extra && typeof scan.extra === 'object' ? Object.entries(scan.extra) : [];
  const actions = scanActions(scan.status);
  const agentSkills =
    Array.isArray(scan.agentSkills) && scan.agentSkills.length
      ? scan.agentSkills
      : (scan.agentSkillNames || []).map((name) => ({ name }));
  const postScripts =
    Array.isArray(scan.postScripts) && scan.postScripts.length
      ? scan.postScripts
      : scan.postScriptName
        ? [{ id: scan.postScriptId, name: scan.postScriptName, primary: true }]
        : [];
  const rateLimit = rateLimitPresentation(scan.reasoning);
  const providerAutoscale = providerCapacityAutoscalePresentation(scan.reasoning);
  const storageWarning = storageWarningPresentation(scan.reasoning);

  return (
    <div
      style={{
        position: 'relative',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {shareDialog && scan.id === id && (
        <ShareResultDialog severity={shareSeverity} automatic={shareDialog.automatic} onClose={closeShareDialog} />
      )}
      <div
        style={{
          height: '100%',
          minWidth: 0,
          overflowY: 'auto',
          padding: '26px 30px',
        }}
      >
        <div
          className="scan-detail-heading"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
              <span style={{ fontSize: 22, fontWeight: 600 }}>{scan.repoDisplay || scan.repoFull}</span>
              <span
                className="mono"
                style={{
                  fontSize: 9.5,
                  fontWeight: 600,
                  letterSpacing: '0.05em',
                  padding: '3px 7px',
                  borderRadius: 5,
                  color: scan.repoKind === 'local' ? 'var(--accent)' : 'var(--run)',
                  background: scan.repoKind === 'local' ? 'var(--accent-subtle)' : 'var(--run-bg)',
                }}
              >
                {(scan.repoKind || 'remote').toUpperCase()}
              </span>
              <StatusBadge status={scan.status} reasoning={scan.reasoning} size="sm" />
            </div>
            <div className="mono" style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 7 }}>
              {scan.workflowName} · {scan.modelProvider ? `${scan.modelProvider} · ` : ''}
              {scan.model} · {scan.harness}
              {scan.thinkingEffort ? ` · ${scan.thinkingEffort}` : ''}
              {Object.keys(scan.modelOverrides || {}).length
                ? ` · ${Object.keys(scan.modelOverrides).length} depth overrides`
                : ''}{' '}
              · {scan.repoKind === 'local' ? 'local snapshot' : `@${scan.commitShort}`}
            </div>
          </div>
          <div className="scan-detail-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {shareEligible && (
              <Button
                variant="subtle"
                style={{ height: 32 }}
                onClick={() => setShareDialog({ automatic: false })}
                title="Create a sanitized image without repository or vulnerability details"
              >
                Share result
              </Button>
            )}
            <Button
              variant="ghost"
              style={{ height: 32 }}
              to={duplicateScanPath(scan.id)}
              title="Create a new scan from this configuration"
            >
              Duplicate scan
            </Button>
            {actions.canDelete && (
              <Button variant="danger" style={{ height: 32 }} onClick={() => !busy && deleteScan()} disabled={busy}>
                Delete
              </Button>
            )}
            {actions.canPause && (
              <Button variant="subtle" style={{ height: 32 }} onClick={() => !busy && setStatus('paused')}>
                {busy ? '…' : 'Pause'}
              </Button>
            )}
            {actions.canStop && (
              <Button variant="danger" style={{ height: 32 }} onClick={() => !busy && setStatus('stopped')}>
                {busy ? '…' : actions.stopLabel}
              </Button>
            )}
            {actions.canResume && (
              <Button
                variant="primary"
                style={{ height: 32 }}
                onClick={() => !busy && setStatus('pending')}
                title="Continue from completed steps and retry failed work"
              >
                {busy ? '…' : 'Resume'}
              </Button>
            )}
          </div>
        </div>

        {actionError && (
          <div style={{ marginTop: 14 }}>
            <ErrorState error={actionError} />
          </div>
        )}

        {storageWarning && (
          <div
            style={{
              marginTop: 14,
              padding: '10px 12px',
              borderRadius: 8,
              color: 'var(--pend)',
              background: 'var(--pend-bg)',
              fontSize: 12.5,
              lineHeight: 1.45,
            }}
          >
            <strong>Low storage.</strong> {storageWarning.message}
          </div>
        )}

        {providerAutoscale && (
          <div
            style={{
              marginTop: 14,
              padding: '10px 12px',
              borderRadius: 8,
              color: 'var(--run)',
              background: 'var(--run-bg)',
              fontSize: 12.5,
            }}
          >
            <strong>Workers adjusted.</strong> {providerAutoscale.message}
          </div>
        )}

        {scan.status === 'rate_limited' && (
          <div
            style={{
              marginTop: 14,
              padding: '10px 12px',
              borderRadius: 8,
              color: 'var(--pend)',
              background: 'var(--pend-bg)',
              fontSize: 12.5,
            }}
          >
            {rateLimit.accountRelated ? (
              <Link to="/accounts" style={{ color: 'inherit', fontWeight: 600 }}>
                {rateLimit.label}.
              </Link>
            ) : (
              <strong>{rateLimit.label}.</strong>
            )}{' '}
            {rateLimit.message} {rateLimitRetryText(scan.reasoning)} Completed work is preserved.
            {rateLimit.accountRelated && (
              <div style={{ marginTop: 6 }}>
                <Link to="/accounts" style={{ color: 'inherit', fontWeight: 600 }}>
                  View usage and provider limits in Accounts
                </Link>
              </div>
            )}
          </div>
        )}

        {scan.status === 'stopped' && scan.reasoning?.code === 'job_limit_reached' && (
          <div
            style={{
              marginTop: 14,
              padding: '10px 12px',
              borderRadius: 8,
              color: 'var(--pend)',
              background: 'var(--pend-bg)',
              fontSize: 12.5,
            }}
          >
            This scan reached its {scan.reasoning.limit}-job limit after starting {scan.reasoning.used} jobs. Increase
            or remove the limit in Run config, then resume.
          </div>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: 12,
            margin: '22px 0 24px',
          }}
        >
          <ScanStat label="Raw candidates" value={scan.rawCandidates ?? scan.findings} />
          <ScanStat label="Findings listed" value={scan.findings} color="var(--accent)" />
          <ScanStat label="Duplicates" value={scan.duplicateFindings ?? 0} />
          <ScanStat label="Exploitable" value={scan.exploitable} color="var(--fail)" />
          <ScanStat label="Post-scripts" value={postScripts.length} />
          <ScanStat label="Agent skills" value={scan.agentSkillCount || 0} />
          <ScanStat
            label={scan.repoKind === 'local' ? 'Revision' : 'Commit'}
            value={scan.repoKind === 'local' ? 'local snapshot' : scan.commitShort}
          />
        </div>

        {postScripts.length > 0 && <ConfiguredPostScripts postScripts={postScripts} />}

        <ScanRunSettings
          scan={scan}
          onSave={saveRunSettings}
          references={modelReferences}
          referencesLoading={modelReferencesLoading}
          referencesError={modelReferencesError}
          catalogError={modelReferences?.catalogError}
          onRetryReferences={reloadModelReferences}
        />

        <ScanStatusPanel scan={scan} />

        {agentSkills.length > 0 && <ConfiguredAgentSkills agentSkills={agentSkills} />}

        {extraEntries.length > 0 && (
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '13px 15px',
              background: 'var(--surface)',
              marginBottom: 24,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <div>
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    letterSpacing: '0.05em',
                    color: 'var(--text-3)',
                    textTransform: 'uppercase',
                  }}
                >
                  Extras
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 11.5,
                    color: 'var(--text-3)',
                    marginTop: 4,
                  }}
                >
                  {extraEntries.length} value
                  {extraEntries.length === 1 ? '' : 's'}
                </div>
              </div>
              <button
                type="button"
                aria-expanded={extrasOpen}
                aria-controls="scan-extra-values"
                onClick={() => setExtrasOpen((open) => !open)}
                style={{
                  height: 28,
                  padding: '0 10px',
                  borderRadius: 7,
                  border: '1px solid var(--border)',
                  background: 'var(--surface-2)',
                  color: 'var(--text-2)',
                  fontSize: 12.5,
                  cursor: 'pointer',
                }}
              >
                {extrasOpen ? 'Hide' : 'Show'}
              </button>
            </div>
            {extrasOpen && (
              <div
                id="scan-extra-values"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: 14,
                  maxHeight: 320,
                  overflowY: 'auto',
                  paddingRight: 4,
                  marginTop: 13,
                }}
              >
                {extraEntries.map(([k, v]) => (
                  <div key={k} style={{ minWidth: 0 }}>
                    <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                      extra.{k}
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 12.5,
                        color: 'var(--text)',
                        marginTop: 4,
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'anywhere',
                        lineHeight: 1.5,
                      }}
                    >
                      {formatExtraValue(v)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {Array.isArray(scan.dependencies) && scan.dependencies.length > 0 && (
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '13px 15px',
              background: 'var(--surface)',
              marginBottom: 24,
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: 10,
                letterSpacing: '0.05em',
                color: 'var(--text-3)',
                textTransform: 'uppercase',
                marginBottom: 8,
              }}
            >
              Dependencies
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {scan.dependencies.map((d, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span
                    className="mono"
                    style={{
                      fontSize: 9.5,
                      fontWeight: 600,
                      letterSpacing: '0.05em',
                      padding: '2px 6px',
                      borderRadius: 5,
                      flex: 'none',
                      color: d.kind === 'local' ? 'var(--accent)' : 'var(--run)',
                      background: d.kind === 'local' ? 'var(--accent-subtle)' : 'var(--run-bg)',
                    }}
                  >
                    {(d.kind || 'remote').toUpperCase()}
                  </span>
                  <span className="mono" style={{ fontSize: 12.5, color: 'var(--text)' }}>
                    {d.display || d.repoFull}
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    {d.kind === 'remote' && d.commitSha ? `@${d.commitSha}` : 'local snapshot'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Vulnerabilities</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 14 }}>
          Ranked by the scan's severity ranker and enriched by post-scripts. Click a finding for the full trace.
        </div>

        {reviewError && (
          <div
            role="alert"
            style={{
              color: 'var(--fail)',
              background: 'var(--fail-bg)',
              borderRadius: 8,
              padding: '9px 11px',
              marginBottom: 12,
              fontSize: 12.5,
            }}
          >
            Could not save the review change. The latest server value is being reloaded. {reviewError.message}
          </div>
        )}

        {vulnsLoading && !vulns ? (
          <Spinner label="Loading vulnerabilities…" />
        ) : vulnsError ? (
          <ErrorState error={vulnsError} onRetry={reloadVulns} />
        ) : list.length === 0 ? (
          <div
            style={{
              border: '1px dashed var(--border)',
              borderRadius: 11,
              padding: '34px 18px',
              textAlign: 'center',
              color: 'var(--text-3)',
              fontSize: 13,
            }}
          >
            {scan.status === 'completed' || scan.status === 'stopped'
              ? 'No vulnerabilities were reported for this scan.'
              : 'Findings will appear here once the scan completes.'}
          </div>
        ) : (
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 11,
              overflow: 'hidden',
              background: 'var(--surface)',
            }}
          >
            <div
              className="scan-results-grid scan-results-header"
              style={{
                padding: '10px 16px',
                borderBottom: '1px solid var(--border-2)',
                background: 'var(--surface-2)',
              }}
            >
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  letterSpacing: '0.05em',
                  color: 'var(--text-3)',
                  textTransform: 'uppercase',
                }}
              >
                Finding
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  letterSpacing: '0.05em',
                  color: 'var(--text-3)',
                  textTransform: 'uppercase',
                }}
              >
                Severity
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  letterSpacing: '0.05em',
                  color: 'var(--text-3)',
                  textTransform: 'uppercase',
                }}
              >
                Post
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  letterSpacing: '0.05em',
                  color: 'var(--text-3)',
                  textTransform: 'uppercase',
                }}
              >
                Actor / Type
              </span>
            </div>
            {findingPages.pageItems.map((v) => {
              const chips = extractChips(v);
              const interesting = v.interesting ?? null;
              const dot = interestingDot(interesting);
              const severity = findingSeverity(v);
              return (
                <div
                  key={v.id}
                  className="scan-results-grid"
                  style={{
                    position: 'relative',
                    padding: '14px 16px',
                    borderBottom: '1px solid var(--border-2)',
                    cursor: 'pointer',
                    // Row color is the interesting indicator: highlight when interesting,
                    // fade when explicitly not interesting, normal when unmarked.
                    background: interesting === 1 ? 'var(--accent-subtle)' : 'transparent',
                    opacity: interesting === 0 ? 0.5 : 1,
                  }}
                >
                  <CardLinkOverlay
                    to={`/scans/${id}/vulnerabilities/${v.id}`}
                    label={`Open finding ${v.rank}: ${v.summary}`}
                  />
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      minWidth: 0,
                    }}
                  >
                    <span
                      onClick={(e) => cycleInteresting(v, e)}
                      title={dot.title}
                      style={{
                        position: 'relative',
                        zIndex: 2,
                        width: 18,
                        flex: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                      }}
                    >
                      <span
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          background: dot.bg,
                          border: `1.5px solid ${dot.border}`,
                        }}
                      />
                    </span>
                    <span
                      className="mono"
                      style={{
                        fontSize: 11,
                        color: 'var(--text-3)',
                        width: 24,
                        flex: 'none',
                      }}
                    >
                      #{v.rank}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        title={v.summary}
                        style={{
                          fontWeight: 500,
                          fontSize: 13.5,
                          lineHeight: 1.35,
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {v.summary}
                      </div>
                      <div
                        className="mono"
                        style={{
                          fontSize: 11.5,
                          color: 'var(--text-3)',
                          marginTop: 4,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          minWidth: 0,
                        }}
                      >
                        <span
                          title={`${v.file_path}:${v.line}`}
                          style={{
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {v.file_path}:{v.line}
                        </span>
                        {v.comments && v.comments.trim() && (
                          <span
                            title="Has a comment"
                            style={{
                              fontSize: 13,
                              color: 'var(--text-3)',
                              flex: 'none',
                            }}
                          >
                            ✎
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <span
                      className="mono"
                      title={severity || 'Unrated'}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 7,
                        maxWidth: '100%',
                        fontSize: 11,
                        fontWeight: 700,
                        padding: '4px 9px',
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                        background: 'var(--surface-2)',
                        color: sevColor(severity),
                        textTransform: 'capitalize',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 2,
                          flex: 'none',
                          background: sevColor(severity),
                        }}
                      />
                      {severity || 'Unrated'}
                    </span>
                  </div>
                  <ChipList chips={chips} fallback={postOutputSummary(v)} />
                  <FindingActorTypeCell maliciousActor={v.malicious_actor} vulnerabilityType={v.vulnerability_type} />
                </div>
              );
            })}
            <Pagination
              {...findingPages}
              itemLabel="findings"
              style={{ padding: '0 16px 14px', borderTop: '1px solid var(--border-2)' }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ScanRunSettings({
  scan,
  onSave,
  references,
  referencesLoading,
  referencesError,
  catalogError,
  onRetryReferences,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const current = runSettingsDraft(scan);
  const activeDraft = mergeRunSettingsDraft(current, draft);
  const payload = draft ? runSettingsPayload(draft, current) : {};
  const dirty = Object.keys(payload).length > 0;
  const workflowDepths = Array.isArray(scan.workflowDepths)
    ? scan.workflowDepths
    : Object.keys(current.model_overrides).map(Number);
  const jobLimit = activeDraft.job_limit.trim();
  const jobLimitValid = !jobLimit || (/^\d+$/.test(jobLimit) && Number(jobLimit) >= 1 && Number(jobLimit) <= 1_000_000);
  const valid =
    jobLimitValid &&
    !!references &&
    workflowModelConfigurationIsValid(activeDraft, workflowDepths, references.providers, references.catalog);
  useUnsavedChangesPrompt(editing && (dirty || saving));

  const open = () => {
    const currentDraft = runSettingsDraft(scan);
    const reconciledDraft = {
      ...currentDraft,
      model_overrides: reconcileModelOverrides(currentDraft.model_overrides, workflowDepths, currentDraft),
    };
    setDraft(
      references
        ? mergeRunSettingsDraft(
            reconciledDraft,
            workflowModelConfigurationForCatalog(reconciledDraft, references.providers, references.catalog)
          )
        : reconciledDraft
    );
    setError(null);
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(null);
    setError(null);
  };
  const save = async () => {
    if (!valid) {
      setError(
        jobLimitValid
          ? 'Choose a configured provider, available model, supported thinking effort, and compatible harness.'
          : 'Maximum model jobs must be a whole number from 1 to 1,000,000.'
      );
      return;
    }
    if (!dirty) {
      cancel();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(payload);
      setEditing(false);
      setDraft(null);
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '13px 15px',
        background: 'var(--surface)',
        marginBottom: 24,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: editing ? 13 : 0,
        }}
      >
        <div>
          <div
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.05em',
              color: 'var(--text-3)',
              textTransform: 'uppercase',
            }}
          >
            Run config
          </div>
          {!editing && (
            <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 4 }}>
              {current.model_provider ? `${current.model_provider} · ` : ''}
              {current.model} · {current.harness}
              {current.thinking_effort ? ` · ${current.thinking_effort}` : ''}
            </div>
          )}
        </div>
        {editing ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="ghost"
              style={{ height: 30, padding: '0 12px', fontSize: 12.5 }}
              disabled={saving}
              onClick={cancel}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              style={{ height: 30, padding: '0 12px', fontSize: 12.5 }}
              disabled={saving || !valid || !dirty}
              onClick={save}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            style={{ height: 30, padding: '0 12px', fontSize: 12.5 }}
            onClick={open}
            disabled={referencesLoading || !!referencesError || !references}
          >
            Edit
          </Button>
        )}
      </div>

      {editing ? (
        <>
          <WorkflowModelConfiguration
            value={activeDraft}
            onChange={(nextDraft) =>
              setDraft((currentDraft) => mergeRunSettingsDraft(currentDraft || current, nextDraft))
            }
            providers={references?.providers || []}
            catalog={references?.catalog || {}}
            catalogError={catalogError}
            disabled={saving}
            depths={workflowDepths}
          />
          <label style={{ display: 'block', maxWidth: 280, marginTop: 13 }}>
            <span
              className="mono"
              style={{
                display: 'block',
                fontSize: 10,
                color: 'var(--text-3)',
                marginBottom: 6,
              }}
            >
              MAXIMUM MODEL JOBS · OPTIONAL
            </span>
            <input
              className="mono"
              type="number"
              min="1"
              max="1000000"
              step="1"
              placeholder="unlimited"
              value={activeDraft.job_limit}
              disabled={saving}
              onChange={(event) =>
                setDraft((currentDraft) => ({
                  ...currentDraft,
                  job_limit: event.target.value,
                }))
              }
              style={{
                width: '100%',
                height: 36,
                padding: '0 10px',
                borderRadius: 7,
                border: `1px solid ${jobLimitValid ? 'var(--border)' : 'var(--fail)'}`,
                background: 'var(--surface)',
                color: 'var(--text)',
              }}
            />
            <span
              style={{
                display: 'block',
                fontSize: 11,
                color: 'var(--text-3)',
                marginTop: 6,
                lineHeight: 1.4,
              }}
            >
              {scan.jobsStarted || 0} logical jobs started. Internal retries do not consume extra jobs.
            </span>
          </label>
          {error && (
            <div className="mono" style={{ fontSize: 11.5, color: 'var(--fail)', marginTop: 10 }}>
              {error}
            </div>
          )}
        </>
      ) : referencesError ? (
        <div style={{ marginTop: 10 }}>
          <ErrorState error={referencesError} onRetry={onRetryReferences} />
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: 12,
            marginTop: 13,
          }}
        >
          <RuntimeSetting label="model" value={current.model} />
          <RuntimeSetting label="model_provider" value={current.model_provider || '—'} />
          <RuntimeSetting label="thinking_effort" value={current.thinking_effort || '—'} />
          <RuntimeSetting label="harness" value={current.harness} />
          <RuntimeSetting label="post model" value={current.post_processing_model || '—'} />
          <RuntimeSetting label="post provider" value={current.post_processing_model_provider || '—'} />
          <RuntimeSetting label="post effort" value={current.post_processing_thinking_effort || '—'} />
          <RuntimeSetting label="post harness" value={current.post_processing_harness || '—'} />
          <RuntimeSetting label="depth overrides" value={Object.keys(current.model_overrides).length || 'none'} />
          <RuntimeSetting
            label="model jobs"
            value={`${scan.jobsStarted || 0} / ${scan.jobLimit == null ? 'unlimited' : scan.jobLimit}`}
          />
        </div>
      )}
    </div>
  );
}

export function runSettingsDraft(scan = {}) {
  return {
    model: scan.model || '',
    model_provider: scan.modelProvider || 'openrouter',
    thinking_effort: scan.thinkingEffort || 'medium',
    post_processing_model_override: Boolean(scan.postProcessingModelOverride),
    post_processing_model: scan.postProcessingModel || scan.model || '',
    post_processing_model_provider: scan.postProcessingModelProvider || scan.modelProvider || 'openrouter',
    post_processing_harness: scan.postProcessingHarness || scan.harness || 'codex',
    post_processing_thinking_effort: scan.postProcessingThinkingEffort || scan.thinkingEffort || 'medium',
    harness: scan.harness || 'codex',
    model_overrides: modelOverridesDraft(scan.modelOverrides),
    job_limit: scan.jobLimit == null ? '' : `${scan.jobLimit}`,
  };
}

function runSettingsValue(value, fallback) {
  if (value === undefined) return fallback;
  if (value === null) return '';
  return typeof value === 'string' ? value : String(value);
}

export function mergeRunSettingsDraft(current = {}, patch = {}) {
  const hasModelOverrides = Object.prototype.hasOwnProperty.call(patch || {}, 'model_overrides');
  const hasPostProcessingModelOverride = Object.prototype.hasOwnProperty.call(
    patch || {},
    'post_processing_model_override'
  );
  const base = {
    model: runSettingsValue(current?.model, ''),
    model_provider: runSettingsValue(current?.model_provider, 'openrouter'),
    thinking_effort: runSettingsValue(current?.thinking_effort, 'medium'),
    post_processing_model_override: Boolean(current?.post_processing_model_override),
    post_processing_model: runSettingsValue(current?.post_processing_model, current?.model || ''),
    post_processing_model_provider: runSettingsValue(
      current?.post_processing_model_provider,
      current?.model_provider || 'openrouter'
    ),
    post_processing_harness: runSettingsValue(current?.post_processing_harness, current?.harness || 'codex'),
    post_processing_thinking_effort: runSettingsValue(
      current?.post_processing_thinking_effort,
      current?.thinking_effort || 'medium'
    ),
    harness: runSettingsValue(current?.harness, 'codex'),
    model_overrides: modelOverridesDraft(current?.model_overrides),
    job_limit: runSettingsValue(current?.job_limit, ''),
  };
  return {
    model: runSettingsValue(patch?.model, base.model),
    model_provider: runSettingsValue(patch?.model_provider, base.model_provider),
    thinking_effort: runSettingsValue(patch?.thinking_effort, base.thinking_effort),
    post_processing_model_override: hasPostProcessingModelOverride
      ? Boolean(patch.post_processing_model_override)
      : base.post_processing_model_override,
    post_processing_model: runSettingsValue(patch?.post_processing_model, base.post_processing_model),
    post_processing_model_provider: runSettingsValue(
      patch?.post_processing_model_provider,
      base.post_processing_model_provider
    ),
    post_processing_harness: runSettingsValue(patch?.post_processing_harness, base.post_processing_harness),
    post_processing_thinking_effort: runSettingsValue(
      patch?.post_processing_thinking_effort,
      base.post_processing_thinking_effort
    ),
    harness: runSettingsValue(patch?.harness, base.harness),
    model_overrides: hasModelOverrides ? modelOverridesDraft(patch.model_overrides) : base.model_overrides,
    job_limit: runSettingsValue(patch?.job_limit, base.job_limit),
  };
}

export function runSettingsPayload(draft, current) {
  const normalizedCurrent = mergeRunSettingsDraft({}, current);
  const normalizedDraft = mergeRunSettingsDraft(normalizedCurrent, draft);
  const payload = {};
  const model = normalizedDraft.model.trim();
  const jobLimit = normalizedDraft.job_limit.trim();
  if (model !== normalizedCurrent.model) payload.model = model;
  if (normalizedDraft.model_provider !== normalizedCurrent.model_provider)
    payload.model_provider = normalizedDraft.model_provider;
  if (normalizedDraft.thinking_effort !== normalizedCurrent.thinking_effort)
    payload.thinking_effort = normalizedDraft.thinking_effort;
  const postProcessingModelChanged =
    normalizedDraft.post_processing_model !== normalizedCurrent.post_processing_model ||
    normalizedDraft.post_processing_model_provider !== normalizedCurrent.post_processing_model_provider ||
    normalizedDraft.post_processing_harness !== normalizedCurrent.post_processing_harness;
  if (normalizedDraft.post_processing_model_override) {
    if (!normalizedCurrent.post_processing_model_override || postProcessingModelChanged) {
      payload.post_processing_model = normalizedDraft.post_processing_model.trim();
      payload.post_processing_model_provider = normalizedDraft.post_processing_model_provider;
      payload.post_processing_harness = normalizedDraft.post_processing_harness;
    }
  } else if (normalizedCurrent.post_processing_model_override) {
    payload.post_processing_model = null;
    payload.post_processing_model_provider = null;
    payload.post_processing_harness = null;
  }
  if (normalizedDraft.post_processing_thinking_effort !== normalizedCurrent.post_processing_thinking_effort)
    payload.post_processing_thinking_effort = normalizedDraft.post_processing_thinking_effort;
  if (normalizedDraft.harness !== normalizedCurrent.harness) payload.harness = normalizedDraft.harness;
  if (!modelOverridesEqual(normalizedDraft.model_overrides, normalizedCurrent.model_overrides))
    payload.model_overrides = normalizedDraft.model_overrides;
  if (normalizedDraft.job_limit !== normalizedCurrent.job_limit) payload.jobLimit = jobLimit ? Number(jobLimit) : null;
  return payload;
}

function formatApiError(error) {
  if (error instanceof ApiError && error.errors?.length) {
    return error.errors.map((e) => `${e.field}: ${e.message}`).join(' · ');
  }
  return error?.message || 'Failed to save run config.';
}

function RuntimeSetting({ label, value }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.05em',
          color: 'var(--text-3)',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        title={value}
        style={{
          fontSize: 12.5,
          color: 'var(--text)',
          marginTop: 5,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function scanErrorTimestamp(error) {
  for (const value of [error?.updatedAt, error?.insertedAt]) {
    if (!value) continue;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    return {
      dateTime: date.toISOString(),
      label: new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'medium',
      }).format(date),
    };
  }
  return null;
}

const EXTENDED_ACTIVE_JOB_MS = 45 * 60 * 1000;
const ACTIVE_JOB_DEPTH_PALETTE_SIZE = 6;
const ACTIVE_JOB_HARNESS_LABELS = Object.freeze({
  codex: 'Codex CLI',
  'claude-code': 'Claude Code',
  droid: 'Factory Droid',
});

function activeJobHarnessLabel(value) {
  const harness = `${value || ''}`.trim();
  return ACTIVE_JOB_HARNESS_LABELS[harness] || harness || 'Not reported';
}

export function activeJobWorkflowDepth(job) {
  if (job?.kind && job.kind !== 'step') return null;
  if (job?.depth != null && job.depth !== '') {
    const explicitDepth = Number(job.depth);
    if (Number.isInteger(explicitDepth) && explicitDepth >= 0) return explicitDepth;
  }
  const titleMatch = `${job?.title || ''}`.match(/^\s*(\d+)\s*·/);
  if (!titleMatch) return null;
  const titleDepth = Number(titleMatch[1]);
  return Number.isInteger(titleDepth) ? titleDepth : null;
}

function activeJobStage(job) {
  const depth = activeJobWorkflowDepth(job);
  if (depth != null) return { key: `depth-${depth}`, label: `D${depth}`, depth };
  if (job?.kind && job.kind !== 'step') return { key: 'post', label: 'POST', depth: null };
  return { key: 'work', label: 'WORK', depth: null };
}

function activeJobDepthStyle(stage) {
  if (stage.depth == null) {
    return { color: 'var(--text-2)', background: 'var(--surface)' };
  }
  const paletteIndex = stage.depth % ACTIVE_JOB_DEPTH_PALETTE_SIZE;
  return {
    color: `var(--depth-${paletteIndex})`,
    background: `var(--depth-${paletteIndex}-bg)`,
  };
}

export function activeJobDepthSummary(jobs = []) {
  const counts = new Map();
  for (const job of jobs) {
    const stage = activeJobStage(job);
    const current = counts.get(stage.key);
    if (current) current.count += 1;
    else counts.set(stage.key, { ...stage, count: 1 });
  }
  return [...counts.values()].sort((left, right) => {
    if (left.depth != null && right.depth != null) return left.depth - right.depth;
    if (left.depth != null) return -1;
    if (right.depth != null) return 1;
    return left.label.localeCompare(right.label);
  });
}

export function formatActiveJobElapsed(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function ActiveJobCard({ job }) {
  const elapsed = formatActiveJobElapsed(job.elapsedMs);
  const extended = Number(job.elapsedMs) >= EXTENDED_ACTIVE_JOB_MS;
  const stage = activeJobStage(job);
  const depthStyle = activeJobDepthStyle(stage);
  const model = `${job.model || ''}`.trim() || 'Not reported';
  const harness = activeJobHarnessLabel(job.harness);

  return (
    <article
      aria-label={`${stage.depth == null ? stage.label : `Workflow depth ${stage.depth}`} worker: ${job.title || job.source || 'Active worker'}`}
      style={{
        minWidth: 0,
        border: `1px solid ${extended ? 'var(--pend)' : 'var(--border)'}`,
        borderRadius: 9,
        background: `linear-gradient(135deg, ${depthStyle.background} 0%, var(--surface-2) 48%)`,
        padding: '10px 11px',
      }}
    >
      <div
        className="mono"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          fontSize: 10.5,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            minWidth: 0,
            color: 'var(--run)',
          }}
        >
          <span
            title={stage.depth == null ? stage.label : `Workflow depth ${stage.depth}`}
            style={{
              flex: '0 0 auto',
              border: `1px solid color-mix(in srgb, ${depthStyle.color} 32%, var(--border))`,
              borderRadius: 5,
              background: depthStyle.background,
              color: depthStyle.color,
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: '0.04em',
              lineHeight: 1,
              padding: '4px 5px 3px',
            }}
          >
            {stage.label}
          </span>
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              flex: '0 0 auto',
              borderRadius: '50%',
              background: 'var(--run)',
            }}
          />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {job.phaseLabel || 'Running'}
          </span>
        </span>
        <span
          title={
            extended
              ? 'Extended run. This is informational and does not mean the worker is stuck or failed.'
              : 'Current active harness duration'
          }
          style={{ flex: '0 0 auto', color: extended ? 'var(--pend)' : 'var(--text-2)' }}
        >
          {extended ? 'extended · ' : ''}
          {elapsed || 'starting'}
        </span>
      </div>

      <div
        title={job.title}
        style={{
          color: 'var(--text)',
          fontSize: 12.5,
          fontWeight: 600,
          lineHeight: 1.35,
          marginTop: 8,
          overflowWrap: 'anywhere',
          whiteSpace: 'normal',
        }}
      >
        {job.title || job.source || 'Active worker'}
      </div>

      <div
        className="mono"
        aria-label={`Model: ${model}; Harness: ${harness}`}
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          alignItems: 'end',
          gap: 10,
          borderTop: '1px solid var(--border)',
          marginTop: 9,
          paddingTop: 8,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              color: 'var(--text-3)',
              fontSize: 8.5,
              letterSpacing: '0.08em',
              lineHeight: 1,
              textTransform: 'uppercase',
            }}
          >
            Model
          </div>
          <div
            title={`Model: ${model}`}
            style={{
              color: 'var(--text)',
              fontSize: 11.5,
              fontWeight: 650,
              lineHeight: 1.25,
              marginTop: 5,
              overflowWrap: 'anywhere',
            }}
          >
            {model}
          </div>
        </div>
        <div style={{ minWidth: 0, textAlign: 'right' }}>
          <div
            style={{
              color: 'var(--text-3)',
              fontSize: 8.5,
              letterSpacing: '0.08em',
              lineHeight: 1,
              textTransform: 'uppercase',
            }}
          >
            Harness
          </div>
          <span
            title={`Harness: ${harness}`}
            style={{
              display: 'inline-block',
              maxWidth: 120,
              border: '1px solid var(--border-2)',
              borderRadius: 999,
              background: 'var(--surface)',
              color: 'var(--text-2)',
              fontSize: 9.5,
              lineHeight: 1,
              marginTop: 4,
              overflow: 'hidden',
              padding: '4px 6px',
              textOverflow: 'ellipsis',
              verticalAlign: 'bottom',
              whiteSpace: 'nowrap',
            }}
          >
            {harness}
          </span>
        </div>
      </div>
    </article>
  );
}

export function ScanStatusPanel({ scan }) {
  const summary = scan.statusSummary || {};
  const rateLimited = scan.status === 'rate_limited';
  const completedLineages = summary.completedStepLineages ?? summary.stepCompletedAttempts ?? 0;
  const expectedLineages = summary.expectedStepLineages ?? summary.stepAttempts ?? 0;
  const activeJobs = summary.activeJobs || [];
  const activeDepths = activeJobDepthSummary(activeJobs);
  const longestActiveJobMs = activeJobs.reduce((longest, job) => {
    const elapsed = Number(job?.elapsedMs);
    return Number.isFinite(elapsed) ? Math.max(longest, elapsed) : longest;
  }, 0);
  const recentErrors = summary.recentErrors || [];
  const currentFailedAttempts = summary.currentFailedAttempts ?? summary.failedAttempts ?? 0;
  const [expandedErrorIds, setExpandedErrorIds] = useState(() => new Set());
  const toggleError = (id) => {
    setExpandedErrorIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  if (!activeJobs.length && !recentErrors.length && !summary.totalAttempts) return null;

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '13px 15px',
        background: 'var(--surface)',
        marginBottom: 24,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <div>
          <div
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.05em',
              color: 'var(--text-3)',
              textTransform: 'uppercase',
            }}
          >
            Status
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 8 }}>
            <RuntimeMetric label="Workflow" value={`${completedLineages}/${expectedLineages}`} />
            <RuntimeMetric label="Attempts" value={summary.totalAttempts || 0} />
            <RuntimeMetric label="Running" value={summary.runningAttempts || 0} color="var(--run)" />
            <RuntimeMetric
              label={rateLimited ? 'Attempt errors' : 'Failed'}
              value={currentFailedAttempts}
              color={currentFailedAttempts ? (rateLimited ? 'var(--pend)' : 'var(--fail)') : 'var(--text)'}
            />
            <RuntimeMetric label="Post" value={`${summary.postCompletedAttempts || 0}/${summary.postAttempts || 0}`} />
          </div>
        </div>
        {summary.progress && (
          <div style={{ minWidth: 160, flex: '0 0 220px' }}>
            <div
              className="mono"
              style={{
                fontSize: 11.5,
                color: 'var(--text-3)',
                marginBottom: 7,
              }}
            >
              {summary.progressLabel || 'progress'}
            </div>
            <div
              style={{
                height: 6,
                background: 'var(--surface-2)',
                borderRadius: 4,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: summary.progress,
                  background: 'var(--run)',
                }}
              />
            </div>
          </div>
        )}
      </div>

      {activeJobs.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div
            className="mono"
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 8,
              marginBottom: 8,
            }}
          >
            <span style={{ color: 'var(--text-2)', fontSize: 11.5 }}>Active workers</span>
            <span style={{ color: 'var(--text-3)', fontSize: 10.5 }}>
              {activeJobs.length} active
              {longestActiveJobMs > 0 ? ` · longest ${formatActiveJobElapsed(longestActiveJobMs)}` : ''}
            </span>
          </div>
          <div
            aria-label="Active workers by workflow depth"
            className="mono"
            style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 9 }}
          >
            {activeDepths.map((stage) => {
              const depthStyle = activeJobDepthStyle(stage);
              const description =
                stage.depth == null
                  ? `${stage.label}: ${stage.count} active worker${stage.count === 1 ? '' : 's'}`
                  : `Depth ${stage.depth}: ${stage.count} active worker${stage.count === 1 ? '' : 's'}`;
              return (
                <span
                  key={stage.key}
                  title={description}
                  aria-label={description}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    border: `1px solid color-mix(in srgb, ${depthStyle.color} 30%, var(--border))`,
                    borderRadius: 999,
                    background: depthStyle.background,
                    color: depthStyle.color,
                    fontSize: 10,
                    lineHeight: 1,
                    padding: '5px 7px',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{ width: 6, height: 6, borderRadius: '50%', background: depthStyle.color }}
                  />
                  <strong style={{ fontWeight: 700 }}>{stage.label}</strong>
                  <span>{stage.count}</span>
                </span>
              );
            })}
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
              gap: 8,
            }}
          >
            {activeJobs.map((job) => (
              <ActiveJobCard key={job.id} job={job} />
            ))}
          </div>
          <div className="mono" style={{ color: 'var(--text-3)', fontSize: 9.5, marginTop: 7 }}>
            Live duration is informational. The engine reports failures separately below.
          </div>
        </div>
      )}

      {recentErrors.length > 0 && (
        <div style={{ marginTop: 15, display: 'grid', gap: 8 }}>
          {recentErrors.slice(0, 5).map((err) => {
            const expanded = expandedErrorIds.has(err.id);
            const previousRun = Boolean(err.previousRun);
            const timestamp = scanErrorTimestamp(err);
            return (
              <div
                key={err.id}
                style={{
                  border: `1px solid ${previousRun ? 'var(--border-2)' : 'var(--fail-bg)'}`,
                  borderRadius: 8,
                  padding: '9px 10px',
                  background: previousRun ? 'var(--surface-2)' : 'var(--fail-bg)',
                }}
              >
                <div
                  className="mono"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 12,
                    fontSize: 11,
                    color: previousRun ? 'var(--text-3)' : 'var(--fail)',
                    marginBottom: 6,
                  }}
                >
                  <span
                    style={{
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {previousRun ? 'Previous run · ' : ''}
                    {err.source} · {err.title}
                  </span>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                      justifyContent: 'flex-end',
                      flex: 'none',
                    }}
                  >
                    {timestamp && (
                      <time
                        dateTime={timestamp.dateTime}
                        title={`Error occurred ${timestamp.label}`}
                        style={{ color: 'var(--text-3)', whiteSpace: 'nowrap' }}
                      >
                        {timestamp.label}
                      </time>
                    )}
                    <span>{err.phaseLabel}</span>
                    <button
                      type="button"
                      onClick={() => toggleError(err.id)}
                      style={{
                        height: 24,
                        padding: '0 8px',
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                        background: 'var(--surface)',
                        color: 'var(--text-2)',
                        fontSize: 11.5,
                        cursor: 'pointer',
                      }}
                    >
                      {expanded ? 'Hide' : 'Show'}
                    </button>
                  </span>
                </div>
                {!previousRun && err.knownError && <KnownErrorBadge knownError={err.knownError} />}
                <ExpandableErrorMessage message={err.message} expanded={expanded} />
                {!previousRun && <ErrorFixLinks knownError={err.knownError} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Post-script chips: any result key prefixed "_chip_" becomes a chip. The label is
// the key without the prefix; the value is shown below it. Capped at MAX_CHIPS.
const CHIP_PREFIX = '_chip_';
const MAX_CHIPS = 3;

export function FindingActorTypeCell({ maliciousActor, vulnerabilityType }) {
  const actor = typeof maliciousActor === 'string' && maliciousActor.trim() ? maliciousActor.trim() : '—';
  const type = typeof vulnerabilityType === 'string' && vulnerabilityType.trim() ? vulnerabilityType.trim() : 'finding';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, minWidth: 0 }}>
      <span
        className="mono"
        aria-label={`Malicious actor: ${actor}`}
        title={`Malicious actor: ${actor}`}
        style={{
          display: 'block',
          maxWidth: '100%',
          fontSize: 11.5,
          fontWeight: 600,
          color: 'var(--text)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {actor}
      </span>
      <span
        className="mono"
        title={type}
        style={{
          display: 'inline-block',
          maxWidth: '100%',
          fontSize: 11.5,
          fontWeight: 700,
          padding: '4px 10px',
          borderRadius: 6,
          border: '1px solid var(--border)',
          background: 'var(--surface-2)',
          color: 'var(--text-2)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          verticalAlign: 'middle',
        }}
      >
        {type}
      </span>
    </div>
  );
}

function chipValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// Pull "_chip_*" keys from the primary post-script answer + every enrichment result.
function extractChips(vuln) {
  const sources = [];
  if (vuln.postScriptAnswer && typeof vuln.postScriptAnswer === 'object') sources.push(vuln.postScriptAnswer);
  for (const e of vuln.enrichments || []) if (e?.result && typeof e.result === 'object') sources.push(e.result);

  const chips = [];
  const seen = new Set();
  for (const result of sources) {
    for (const [key, value] of Object.entries(result)) {
      if (!key.startsWith(CHIP_PREFIX)) continue;
      const label = key.slice(CHIP_PREFIX.length);
      if (!label || seen.has(label)) continue;
      seen.add(label);
      chips.push({ label, value: chipValue(value) });
    }
  }
  return chips;
}

function ChipList({ chips, fallback }) {
  if (!chips.length && !fallback)
    return (
      <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
        —
      </span>
    );
  const shown = chips.length ? chips.slice(0, MAX_CHIPS) : [fallback];
  const extra = chips.length ? chips.length - shown.length : 0;
  const hiddenLabels = chips
    .slice(MAX_CHIPS)
    .map((c) => c.label)
    .join(', ');
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minWidth: 0 }}>
      {shown.map((c, i) => (
        <div
          key={i}
          title={`${c.label}: ${c.value}`}
          style={{
            display: 'inline-flex',
            flexDirection: 'column',
            padding: '3px 9px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--surface-2)',
            maxWidth: 150,
            minWidth: 0,
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: 8.5,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--text-3)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              lineHeight: 1.45,
            }}
          >
            {c.label.replaceAll('_', ' ')}
          </span>
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--text)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              lineHeight: 1.35,
            }}
          >
            {c.value}
          </span>
        </div>
      ))}
      {extra > 0 && (
        <span
          title={`${extra} more: ${hiddenLabels}`}
          className="mono"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-2)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '0 9px',
          }}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

function ExpandableErrorMessage({ message, expanded }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 11.5,
        color: 'var(--text-2)',
        lineHeight: 1.45,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        ...(expanded
          ? { maxHeight: 240, overflowY: 'auto', paddingRight: 4 }
          : {
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }),
      }}
    >
      <LinkifiedText text={message} />
    </div>
  );
}

function KnownErrorBadge({ knownError }) {
  if (!knownError?.title) return null;
  return (
    <span
      className="mono"
      style={{
        display: 'inline-flex',
        marginBottom: 6,
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid var(--fail)',
        background: 'var(--surface)',
        color: 'var(--fail)',
        fontSize: 10.5,
      }}
    >
      {knownError.title}
    </span>
  );
}

function ErrorFixLinks({ knownError }) {
  const links = knownError?.fixLinks || [];
  if (!links.length) return null;
  return (
    <div
      className="mono"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 7,
        fontSize: 11,
      }}
    >
      {links.map((link) =>
        link.internal || link.url?.startsWith('/') ? (
          <Link
            key={`${link.label}-${link.url}`}
            to={link.url}
            style={{
              color: 'var(--accent)',
              textDecoration: 'none',
              borderBottom: '1px solid var(--accent)',
            }}
          >
            {link.label || link.url}
          </Link>
        ) : (
          <a
            key={`${link.label}-${link.url}`}
            href={link.url}
            target="_blank"
            rel="noreferrer"
            style={{
              color: 'var(--accent)',
              textDecoration: 'none',
              borderBottom: '1px solid var(--accent)',
            }}
          >
            {link.label || link.url}
          </a>
        )
      )}
    </div>
  );
}

function RuntimeMetric({ label, value, color = 'var(--text)' }) {
  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.05em',
          color: 'var(--text-3)',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 17, fontWeight: 600, marginTop: 3, color }}>{value}</div>
    </div>
  );
}

// Left dot toggle for the 3-state interesting flag (1 / 0 / null). Clicking cycles
// it; the row background reflects the same state more prominently.
function interestingDot(intr) {
  const v = intr ?? null;
  if (v === 1)
    return {
      bg: 'var(--accent)',
      border: 'var(--accent)',
      title: 'Interesting — click to change',
    };
  if (v === 0)
    return {
      bg: 'var(--text-3)',
      border: 'var(--text-3)',
      title: 'Not interesting — click to change',
    };
  return {
    bg: 'transparent',
    border: 'var(--border)',
    title: 'Unmarked — click to flag',
  };
}

function ScanStat({ label, value, color = 'var(--text)' }) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '13px 15px',
        background: 'var(--surface)',
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.05em',
          color: 'var(--text-3)',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 6, color }}>{value}</div>
    </div>
  );
}

function ConfiguredPostScripts({ postScripts }) {
  const postScriptPages = usePagination(postScripts, { pageSize: 10 });

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '13px 15px',
        background: 'var(--surface)',
        marginBottom: 24,
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.05em',
          color: 'var(--text-3)',
          textTransform: 'uppercase',
          marginBottom: 8,
        }}
      >
        Configured post-scripts
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
        {postScriptPages.pageItems.map((postScript) => (
          <span
            key={postScript.id || postScript.name}
            className="mono"
            style={{
              fontSize: 11,
              color: postScript.primary ? 'var(--accent)' : 'var(--text-2)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-2)',
              borderRadius: 6,
              padding: '3px 8px',
            }}
          >
            {postScript.name}
            {postScript.primary ? ' · primary' : ''}
          </span>
        ))}
      </div>
      <Pagination {...postScriptPages} itemLabel="post-scripts" compact />
    </div>
  );
}

function ConfiguredAgentSkills({ agentSkills }) {
  const skillPages = usePagination(agentSkills, { pageSize: 10 });

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '13px 15px',
        background: 'var(--surface)',
        marginBottom: 24,
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.05em',
          color: 'var(--text-3)',
          textTransform: 'uppercase',
          marginBottom: 8,
        }}
      >
        Agent skills
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
        {skillPages.pageItems.map((skill) =>
          skill.sourceUrl ? (
            <a
              key={skill.id || skill.name}
              href={skill.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="mono"
              style={{
                fontSize: 11,
                color: 'var(--accent)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-2)',
                borderRadius: 6,
                padding: '3px 8px',
                textDecoration: 'none',
              }}
            >
              {skill.name}
            </a>
          ) : (
            <span
              key={skill.id || skill.name}
              className="mono"
              style={{
                fontSize: 11,
                color: 'var(--text-2)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-2)',
                borderRadius: 6,
                padding: '3px 8px',
              }}
            >
              {skill.name}
            </span>
          )
        )}
      </div>
      <Pagination {...skillPages} itemLabel="skills" compact />
    </div>
  );
}

function formatExtraValue(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
