import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
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
import ModelConfiguration, {
  modelConfigurationForCatalog,
  modelConfigurationIsValid,
} from '../components/ModelConfiguration.jsx';
import { modelOverridesDraft, modelOverridesEqual, reconcileModelOverrides } from '../lib/modelOverrides.js';
import { usePagination } from '../lib/usePagination.js';
import Pagination from '../components/Pagination.jsx';
import { saveBrowserDownload } from '../lib/download.js';
import { extractExtraKeys } from '../lib/keys.js';

const SUPPLEMENTAL_POST_SCRIPT_SCAN_STATUSES = new Set(['paused', 'completed', 'stopped', 'failed']);

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

export function scanFindingExportAvailability(scan) {
  if (!['completed', 'stopped', 'failed'].includes(scan?.status)) {
    return {
      ready: false,
      message: 'Available after the scan completes, stops, or fails.',
    };
  }
  if (!Number(scan?.findings)) return { ready: false, message: 'This scan has no findings to export.' };
  if (scan.status !== 'completed') {
    return {
      ready: true,
      message: `Download a partial export from this ${scan.status} scan. Some findings or post-processing artifacts may be missing.`,
    };
  }
  return {
    ready: true,
    message: 'Download a share-safe index and untrusted finding, report, PoC, and post-processing content.',
  };
}

export function supplementalPostScriptAvailability(scan, findings = []) {
  if (!SUPPLEMENTAL_POST_SCRIPT_SCAN_STATUSES.has(scan?.status)) {
    return { ready: false, message: 'Pause or stop the scan before adding post-processing.' };
  }
  if (!Array.isArray(findings) || findings.length === 0) {
    return { ready: false, message: 'At least one finding is required.' };
  }
  return { ready: true, message: 'Run a post-script on selected findings without resuming the scan.' };
}

export function supplementalFindingRunSummary(finding, runs = []) {
  const runIds = new Set(
    (finding?.enrichments || [])
      .map((enrichment) => enrichment?.supplementalRunId)
      .filter(Boolean)
      .map(String)
  );
  let active = 0;
  let failed = 0;
  for (const run of runs || []) {
    const target = (run?.targets || []).find((item) => String(item.vulnerabilityId) === String(finding?.id));
    if (!target) continue;
    runIds.add(String(run.id));
    if (['pending', 'running'].includes(target.status)) active += 1;
    if (target.status === 'failed') failed += 1;
  }
  return { count: runIds.size, active, failed };
}

export function supplementalRunModelConfiguration(scan = {}, run = null) {
  return {
    model: run?.model || scan.postProcessingModel || scan.model || '',
    model_provider: run?.modelProvider || scan.postProcessingModelProvider || scan.modelProvider || 'openrouter',
    harness: run?.harness || scan.postProcessingHarness || scan.harness || '',
    thinking_effort: run?.thinkingEffort || scan.postProcessingThinkingEffort || scan.thinkingEffort || 'medium',
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
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [reviewError, setReviewError] = useState(null);
  const [supplementalMode, setSupplementalMode] = useState(false);
  const [selectedFindingIds, setSelectedFindingIds] = useState(() => new Set());
  const [supplementalPostScriptId, setSupplementalPostScriptId] = useState('');
  const [supplementalExtra, setSupplementalExtra] = useState({});
  const [supplementalModel, setSupplementalModel] = useState(null);
  const [supplementalSubmitting, setSupplementalSubmitting] = useState(false);
  const [supplementalError, setSupplementalError] = useState(null);
  const [supplementalRetry, setSupplementalRetry] = useState(null);
  const [supplementalRetrySubmitting, setSupplementalRetrySubmitting] = useState(false);
  const [supplementalRetryError, setSupplementalRetryError] = useState(null);
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
  const {
    data: availablePostScripts,
    loading: availablePostScriptsLoading,
    error: availablePostScriptsError,
    reload: reloadAvailablePostScripts,
  } = useFetch(() => api.postScripts(), [], {});
  const {
    data: supplementalRuns,
    error: supplementalRunsError,
    reload: reloadSupplementalRuns,
    setData: setSupplementalRuns,
  } = useFetch(() => api.supplementalPostScriptRuns(id), [id], { pollMs: 1000 });

  useEffect(() => {
    reviewMutations.current.dispose();
    const queue = createLatestFieldMutationQueue();
    reviewMutations.current = queue;
    setReviewError(null);
    return () => queue.dispose();
  }, [id]);

  useEffect(() => {
    setSupplementalMode(false);
    setSelectedFindingIds(new Set());
    setSupplementalPostScriptId('');
    setSupplementalExtra({});
    setSupplementalModel(null);
    setSupplementalError(null);
    setSupplementalRetry(null);
    setSupplementalRetryError(null);
  }, [id]);

  const findingPages = usePagination(vulns || [], { pageSize: 20, resetKey: id });

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

  const exportFindings = async () => {
    if (exporting) return;
    setExporting(true);
    setActionError(null);
    try {
      saveBrowserDownload(await api.exportScanFindings(id));
    } catch (exportError) {
      setActionError(exportError);
    } finally {
      setExporting(false);
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
  const extraEntries = scan.extra && typeof scan.extra === 'object' ? Object.entries(scan.extra) : [];
  const actions = scanActions(scan.status);
  const exportAvailability = scanFindingExportAvailability(scan);
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
  const supplementalAvailability = supplementalPostScriptAvailability(scan, list);
  const selectedPostScript = (availablePostScripts || []).find(
    (postScript) => String(postScript.id) === supplementalPostScriptId
  );
  const supplementalExtraKeys = extractExtraKeys(selectedPostScript?.content || '');
  const selectedCount = selectedFindingIds.size;
  const allFindingsSelected = list.length > 0 && selectedCount === list.length;
  const activeSupplementalRuns = (supplementalRuns || []).filter((run) => ['queued', 'running'].includes(run.status));

  const beginSupplementalRun = () => {
    const defaults = supplementalRunModelConfiguration(scan);
    setSupplementalMode(true);
    setSelectedFindingIds(new Set());
    setSupplementalPostScriptId('');
    setSupplementalExtra({});
    setSupplementalModel(
      modelReferences
        ? modelConfigurationForCatalog(defaults, modelReferences.providers, modelReferences.catalog)
        : defaults
    );
    setSupplementalError(null);
    setSupplementalRetry(null);
    setSupplementalRetryError(null);
  };
  const cancelSupplementalRun = () => {
    setSupplementalMode(false);
    setSelectedFindingIds(new Set());
    setSupplementalPostScriptId('');
    setSupplementalExtra({});
    setSupplementalModel(null);
    setSupplementalError(null);
  };
  const toggleFindingSelection = (vulnerabilityId) => {
    setSelectedFindingIds((current) => {
      const next = new Set(current);
      if (next.has(vulnerabilityId)) next.delete(vulnerabilityId);
      else next.add(vulnerabilityId);
      return next;
    });
  };
  const toggleAllFindingSelection = () => {
    setSelectedFindingIds(allFindingsSelected ? new Set() : new Set(list.map((finding) => finding.id)));
  };
  const chooseSupplementalPostScript = (postScriptId) => {
    setSupplementalPostScriptId(postScriptId);
    const postScript = (availablePostScripts || []).find((item) => String(item.id) === postScriptId);
    const nextExtra = {};
    for (const key of extractExtraKeys(postScript?.content || '')) {
      nextExtra[key] = scan.extra?.[key] === undefined ? '' : formatExtraValue(scan.extra[key]);
    }
    setSupplementalExtra(nextExtra);
    setSupplementalError(null);
  };
  const submitSupplementalRun = async () => {
    if (!selectedCount) {
      setSupplementalError(new Error('Select at least one finding.'));
      return;
    }
    if (!selectedPostScript) {
      setSupplementalError(new Error('Choose a post-script.'));
      return;
    }
    const missingKey = supplementalExtraKeys.find((key) => !String(supplementalExtra[key] ?? '').trim());
    if (missingKey) {
      setSupplementalError(new Error(`extra.${missingKey} is required.`));
      return;
    }
    if (
      !supplementalModel ||
      !modelReferences ||
      !modelConfigurationIsValid(supplementalModel, modelReferences.providers, modelReferences.catalog)
    ) {
      setSupplementalError(new Error('Choose an available model, compatible harness, and supported thinking effort.'));
      return;
    }
    setSupplementalSubmitting(true);
    setSupplementalError(null);
    try {
      await api.createSupplementalPostScriptRun(id, {
        postScriptId: selectedPostScript.id,
        vulnerabilityIds: [...selectedFindingIds],
        extra: Object.fromEntries(supplementalExtraKeys.map((key) => [key, supplementalExtra[key]])),
        model: supplementalModel.model,
        model_provider: supplementalModel.model_provider,
        harness: supplementalModel.harness,
        thinking_effort: supplementalModel.thinking_effort,
      });
      cancelSupplementalRun();
      reloadSupplementalRuns();
      reloadVulns();
    } catch (submitError) {
      setSupplementalError(submitError);
    } finally {
      setSupplementalSubmitting(false);
    }
  };
  const beginSupplementalRetry = (run) => {
    const defaults = supplementalRunModelConfiguration(scan, run);
    cancelSupplementalRun();
    setSupplementalRetry({
      runId: run.id,
      model: modelReferences
        ? modelConfigurationForCatalog(defaults, modelReferences.providers, modelReferences.catalog)
        : defaults,
    });
    setSupplementalRetryError(null);
  };
  const submitSupplementalRetry = async () => {
    if (!supplementalRetry) return;
    if (
      !modelReferences ||
      !modelConfigurationIsValid(supplementalRetry.model, modelReferences.providers, modelReferences.catalog)
    ) {
      setSupplementalRetryError(
        new Error('Choose an available model, compatible harness, and supported thinking effort.')
      );
      return;
    }
    setSupplementalRetrySubmitting(true);
    setSupplementalRetryError(null);
    try {
      const createdRun = await api.retrySupplementalPostScriptRun(id, supplementalRetry.runId, {
        model: supplementalRetry.model.model,
        model_provider: supplementalRetry.model.model_provider,
        harness: supplementalRetry.model.harness,
        thinking_effort: supplementalRetry.model.thinking_effort,
      });
      setSupplementalRuns((current) => [
        createdRun,
        ...(current || []).filter((run) => String(run.id) !== String(createdRun.id)),
      ]);
      setSupplementalRetry(null);
      reloadSupplementalRuns();
      reloadVulns();
    } catch (retryError) {
      setSupplementalRetryError(retryError);
    } finally {
      setSupplementalRetrySubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'relative',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
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
            <Button
              variant="subtle"
              style={{ height: 32 }}
              onClick={exportFindings}
              disabled={!exportAvailability.ready || busy || exporting}
              title={exportAvailability.message}
            >
              {exporting ? 'Exporting…' : 'Export findings'}
            </Button>
            <Button
              variant="ghost"
              style={{ height: 32 }}
              to={duplicateScanPath(scan.id)}
              title="Create a new scan from this configuration"
            >
              Duplicate scan
            </Button>
            {actions.canDelete && (
              <Button
                variant="danger"
                style={{ height: 32 }}
                onClick={() => !busy && !exporting && deleteScan()}
                disabled={busy || exporting || activeSupplementalRuns.length > 0}
                title={
                  activeSupplementalRuns.length
                    ? 'Wait for supplemental post-script work to finish before deleting this scan.'
                    : undefined
                }
              >
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
                disabled={busy || activeSupplementalRuns.length > 0}
                title={
                  activeSupplementalRuns.length
                    ? 'Wait for supplemental post-script work to finish before resuming.'
                    : 'Continue from completed steps and retry failed work'
                }
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

        <SupplementalPostScriptControls
          availability={supplementalAvailability}
          mode={supplementalMode}
          onBegin={beginSupplementalRun}
          onCancel={cancelSupplementalRun}
          selectedCount={selectedCount}
          totalCount={list.length}
          allSelected={allFindingsSelected}
          onToggleAll={toggleAllFindingSelection}
          postScripts={availablePostScripts || []}
          postScriptsLoading={availablePostScriptsLoading}
          postScriptsError={availablePostScriptsError}
          onRetryPostScripts={reloadAvailablePostScripts}
          selectedPostScriptId={supplementalPostScriptId}
          onSelectPostScript={chooseSupplementalPostScript}
          requiredExtraKeys={supplementalExtraKeys}
          extra={supplementalExtra}
          onExtraChange={(key, value) => setSupplementalExtra((current) => ({ ...current, [key]: value }))}
          model={supplementalModel}
          onModelChange={setSupplementalModel}
          modelReferences={modelReferences}
          modelReferencesLoading={modelReferencesLoading}
          modelReferencesError={modelReferencesError}
          submitting={supplementalSubmitting}
          error={supplementalError}
          onSubmit={submitSupplementalRun}
          runs={supplementalRuns || []}
          runsError={supplementalRunsError}
          findings={list}
          scanId={id}
          retry={supplementalRetry}
          onBeginRetry={beginSupplementalRetry}
          onCancelRetry={() => {
            setSupplementalRetry(null);
            setSupplementalRetryError(null);
          }}
          onRetryModelChange={(model) => setSupplementalRetry((current) => (current ? { ...current, model } : null))}
          onSubmitRetry={submitSupplementalRetry}
          retrySubmitting={supplementalRetrySubmitting}
          retryError={supplementalRetryError}
        />

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
                {supplementalMode ? (
                  <label
                    style={{ position: 'relative', zIndex: 2, display: 'inline-flex', alignItems: 'center', gap: 8 }}
                  >
                    <input
                      type="checkbox"
                      checked={allFindingsSelected}
                      onChange={toggleAllFindingSelection}
                      aria-label="Select all findings"
                    />
                    Finding
                  </label>
                ) : (
                  'Finding'
                )}
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
              const supplementalSummary = supplementalFindingRunSummary(v, supplementalRuns || []);
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
                    {supplementalMode && (
                      <input
                        type="checkbox"
                        checked={selectedFindingIds.has(v.id)}
                        onClick={(event) => event.stopPropagation()}
                        onChange={() => toggleFindingSelection(v.id)}
                        aria-label={`Select finding ${v.rank}`}
                        style={{ position: 'relative', zIndex: 2, flex: 'none' }}
                      />
                    )}
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
                        {supplementalSummary.count > 0 && (
                          <span
                            className="mono"
                            title={`${supplementalSummary.count} supplemental post-script run${
                              supplementalSummary.count === 1 ? '' : 's'
                            }${supplementalSummary.active ? ` · ${supplementalSummary.active} active` : ''}${
                              supplementalSummary.failed ? ` · ${supplementalSummary.failed} failed` : ''
                            }`}
                            style={{
                              flex: 'none',
                              padding: '2px 6px',
                              borderRadius: 5,
                              color: supplementalSummary.failed ? 'var(--pend)' : 'var(--accent)',
                              background: supplementalSummary.failed ? 'var(--pend-bg)' : 'var(--accent-subtle)',
                              fontSize: 9.5,
                              fontWeight: 650,
                            }}
                          >
                            +post ×{supplementalSummary.count}
                            {supplementalSummary.active ? ' · running' : ''}
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

export function SupplementalPostScriptControls({
  availability,
  mode,
  onBegin,
  onCancel,
  selectedCount,
  totalCount,
  allSelected,
  onToggleAll,
  postScripts,
  postScriptsLoading,
  postScriptsError,
  onRetryPostScripts,
  selectedPostScriptId,
  onSelectPostScript,
  requiredExtraKeys,
  extra,
  onExtraChange,
  model,
  onModelChange,
  modelReferences,
  modelReferencesLoading,
  modelReferencesError,
  submitting,
  error,
  onSubmit,
  runs,
  runsError,
  findings,
  scanId,
  retry,
  onBeginRetry,
  onCancelRetry,
  onRetryModelChange,
  onSubmitRetry,
  retrySubmitting,
  retryError,
}) {
  const visible = mode || availability.ready || runs.length > 0 || runsError;
  if (!visible) return null;
  const modelValid =
    !!model &&
    !!modelReferences &&
    modelConfigurationIsValid(model, modelReferences.providers, modelReferences.catalog);
  const retryModelValid =
    !!retry?.model &&
    !!modelReferences &&
    modelConfigurationIsValid(retry.model, modelReferences.providers, modelReferences.catalog);
  const findingsById = new Map((findings || []).map((finding) => [String(finding.id), finding]));
  const retriedRunIds = new Set(
    (runs || [])
      .map((run) => run.retryOfRunId)
      .filter(Boolean)
      .map(String)
  );

  return (
    <section
      aria-label="Additional post-processing"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 11,
        background: 'var(--surface)',
        marginBottom: 16,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          padding: '13px 15px',
        }}
      >
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 650 }}>Additional post-processing</div>
          <div style={{ marginTop: 3, color: 'var(--text-3)', fontSize: 11.5 }}>
            {mode
              ? `${selectedCount} of ${totalCount} findings selected`
              : 'Apply a post-script to selected findings without resuming the scan.'}
          </div>
        </div>
        {!mode ? (
          <Button variant="subtle" onClick={onBegin} disabled={!availability.ready} title={availability.message}>
            Run post-script on findings
          </Button>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ghost" onClick={onToggleAll} disabled={submitting}>
              {allSelected ? 'Clear selection' : 'Select all'}
            </Button>
            <Button variant="ghost" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
          </div>
        )}
      </div>

      {mode && (
        <div style={{ borderTop: '1px solid var(--border-2)', padding: '15px' }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-2)' }}>
            Post-script
            <select
              value={selectedPostScriptId}
              onChange={(event) => onSelectPostScript(event.target.value)}
              disabled={submitting || postScriptsLoading}
              className="account-credential-input"
              style={{ marginTop: 7 }}
            >
              <option value="">{postScriptsLoading ? 'Loading post-scripts…' : 'Choose a post-script'}</option>
              {postScripts.map((postScript) => (
                <option key={postScript.id} value={postScript.id}>
                  {postScript.name}
                </option>
              ))}
            </select>
          </label>
          {postScriptsError && (
            <div className="account-dialog-error" role="alert">
              Could not load post-scripts. {postScriptsError.message}{' '}
              <button
                type="button"
                onClick={onRetryPostScripts}
                style={{ border: 0, padding: 0, color: 'inherit', background: 'transparent', cursor: 'pointer' }}
              >
                Try again
              </button>
            </div>
          )}
          <div
            style={{
              marginTop: 14,
              padding: 13,
              border: '1px solid var(--border)',
              borderRadius: 9,
              background: 'var(--surface-2)',
            }}
          >
            <span className="mono" style={{ display: 'block', fontSize: 10.5, color: 'var(--text-3)' }}>
              EXECUTION MODEL
            </span>
            <div style={{ margin: '5px 0 11px', color: 'var(--text-3)', fontSize: 11.5 }}>
              Prefilled from this scan&apos;s post-processing settings. Changes apply only to this supplemental run.
            </div>
            {modelReferencesLoading || !modelReferences || !model ? (
              <div style={{ color: modelReferencesError ? 'var(--fail)' : 'var(--text-3)', fontSize: 12 }}>
                {modelReferencesError ? formatApiError(modelReferencesError) : 'Loading model choices…'}
              </div>
            ) : (
              <ModelConfiguration
                value={model}
                onChange={onModelChange}
                providers={modelReferences.providers}
                catalog={modelReferences.catalog}
                catalogError={modelReferences.catalogError}
                disabled={submitting}
                showAvailabilityHelp={false}
              />
            )}
          </div>
          {requiredExtraKeys.length > 0 && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: 12,
                marginTop: 14,
              }}
            >
              {requiredExtraKeys.map((key) => (
                <label key={key} style={{ display: 'block', fontSize: 12, color: 'var(--text-2)' }}>
                  <span className="mono">extra.{key}</span> <span style={{ color: 'var(--fail)' }}>*</span>
                  <input
                    value={extra[key] ?? ''}
                    onChange={(event) => onExtraChange(key, event.target.value)}
                    disabled={submitting}
                    required
                    className="account-credential-input"
                    style={{ marginTop: 7 }}
                    placeholder={`Value for extra.${key}`}
                  />
                </label>
              ))}
            </div>
          )}
          {error && (
            <div className="account-dialog-error" role="alert">
              {formatApiError(error)}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 15 }}>
            <Button
              onClick={onSubmit}
              disabled={submitting || selectedCount === 0 || !selectedPostScriptId || postScriptsLoading || !modelValid}
            >
              {submitting ? 'Queuing…' : `Queue for ${selectedCount} finding${selectedCount === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>
      )}

      {(runs.length > 0 || runsError) && (
        <div style={{ borderTop: '1px solid var(--border-2)', padding: '11px 15px 13px' }}>
          <div className="mono" style={{ fontSize: 9.5, color: 'var(--text-3)', textTransform: 'uppercase' }}>
            Supplemental run history
          </div>
          {runsError ? (
            <div style={{ marginTop: 7, color: 'var(--fail)', fontSize: 11.5 }}>{runsError.message}</div>
          ) : (
            <div style={{ display: 'grid', gap: 7, marginTop: 8 }}>
              {runs.map((run) => {
                const progress = run.targetCount
                  ? Math.round(((run.completedCount + run.failedCount) / run.targetCount) * 100)
                  : 0;
                const failedTargets = (run.targets || []).filter((target) => target.status === 'failed');
                const retrying = String(retry?.runId) === String(run.id);
                const wasRetried = retriedRunIds.has(String(run.id));
                const statusColor =
                  run.status === 'completed'
                    ? 'var(--ok)'
                    : run.status === 'completed_with_errors'
                      ? 'var(--pend)'
                      : 'var(--run)';
                return (
                  <div
                    key={run.id}
                    style={{
                      minWidth: 0,
                      padding: '10px 11px',
                      border: '1px solid var(--border-2)',
                      borderRadius: 8,
                      background: 'var(--surface-2)',
                      fontSize: 11.5,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <span className="mono" style={{ color: statusColor, width: 152, flex: 'none' }}>
                        {run.status.replaceAll('_', ' ')}
                      </span>
                      <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {run.postScriptName}
                      </span>
                      <span className="mono" style={{ color: 'var(--text-3)', flex: 'none' }}>
                        {run.completedCount + run.failedCount}/{run.targetCount} · {progress}%
                        {run.failedCount ? ` · ${run.failedCount} failed` : ''}
                      </span>
                    </div>
                    <div className="mono" style={{ marginTop: 6, color: 'var(--text-3)', fontSize: 10.5 }}>
                      {run.modelProvider && run.model
                        ? `${run.modelProvider} · ${run.model} · ${run.harness || 'default harness'} · ${
                            run.thinkingEffort || 'default effort'
                          }`
                        : 'Scan post-processing model'}
                    </div>
                    {failedTargets.length > 0 && (
                      <>
                        <details style={{ marginTop: 9 }}>
                          <summary style={{ color: 'var(--fail)', cursor: 'pointer', fontWeight: 600 }}>
                            View {failedTargets.length} error{failedTargets.length === 1 ? '' : 's'}
                          </summary>
                          <div
                            style={{
                              display: 'grid',
                              gap: 8,
                              maxHeight: 280,
                              overflowY: 'auto',
                              marginTop: 8,
                            }}
                          >
                            {failedTargets.map((target) => {
                              const finding = findingsById.get(String(target.vulnerabilityId));
                              return (
                                <div
                                  key={target.id}
                                  style={{ padding: '8px 9px', borderRadius: 7, background: 'var(--fail-bg)' }}
                                >
                                  <Link
                                    to={`/scans/${scanId}/vulnerabilities/${target.vulnerabilityId}`}
                                    style={{ color: 'var(--text)', fontWeight: 600 }}
                                  >
                                    {finding
                                      ? `Finding #${finding.rank}: ${finding.summary}`
                                      : `Finding ${target.vulnerabilityId}`}
                                  </Link>
                                  <div
                                    className="mono"
                                    style={{ marginTop: 5, color: 'var(--fail)', whiteSpace: 'pre-wrap' }}
                                  >
                                    {target.error || 'The worker did not record an error message.'}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </details>
                        {!retrying && !wasRetried && (
                          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 9 }}>
                            <Button
                              variant="ghost"
                              onClick={() => onBeginRetry(run)}
                              disabled={retrySubmitting || !availability.ready}
                            >
                              Re-run failed
                            </Button>
                          </div>
                        )}
                        {wasRetried && (
                          <div style={{ marginTop: 9, color: 'var(--text-3)', textAlign: 'right' }}>
                            Failed findings were re-run.
                          </div>
                        )}
                      </>
                    )}
                    {retrying && (
                      <div
                        style={{
                          marginTop: 10,
                          padding: 11,
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          background: 'var(--surface)',
                        }}
                      >
                        <div style={{ marginBottom: 10, color: 'var(--text-2)', lineHeight: 1.5 }}>
                          Re-run only the {failedTargets.length} failed finding
                          {failedTargets.length === 1 ? '' : 's'}. The original script and extra values are reused; you
                          can change the execution model below.
                        </div>
                        {modelReferences && retry?.model ? (
                          <ModelConfiguration
                            value={retry.model}
                            onChange={onRetryModelChange}
                            providers={modelReferences.providers}
                            catalog={modelReferences.catalog}
                            catalogError={modelReferences.catalogError}
                            disabled={retrySubmitting}
                            showAvailabilityHelp={false}
                          />
                        ) : (
                          <div style={{ color: 'var(--fail)' }}>Model choices are not available.</div>
                        )}
                        {retryError && (
                          <div className="account-dialog-error" role="alert">
                            {formatApiError(retryError)}
                          </div>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                          <Button variant="ghost" onClick={onCancelRetry} disabled={retrySubmitting}>
                            Cancel
                          </Button>
                          <Button onClick={onSubmitRetry} disabled={retrySubmitting || !retryModelValid}>
                            {retrySubmitting ? 'Queuing…' : `Queue retry for ${failedTargets.length}`}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
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
