import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import { usePageChrome } from '../context/ui.jsx';
import { Spinner, ErrorState, Button } from '../components/ui.jsx';
import Markdown from '../components/Markdown.jsx';
import SearchSelect from '../components/SearchSelect.jsx';
import WorkflowModelConfiguration, {
  workflowModelConfigurationForCatalog,
  workflowModelConfigurationIsValid,
} from '../components/WorkflowModelConfiguration.jsx';
import { configuredModelCatalog, configuredModelProviders, modelCatalogIsReady } from '../lib/modelProviders.js';
import { modelOverridesEqual, reconcileModelOverrides, workflowDepths } from '../lib/modelOverrides.js';
import { combineSeverityRanker } from '../lib/severityRanker.js';
import { defaultRankerIds, defaultWorkflowId } from '../lib/scanPresentation.js';
import { scanConfigurationDraft } from '../lib/scanDuplication.js';
import { requiredScanExtraKeys } from '../lib/scanExtras.js';
import { filterAgentSkills } from '../lib/agentSkillSearch.js';
import { configuredMaxFiles, localRepoFilePreflight } from '../lib/localRepoFiles.js';
import { useUnsavedChangesPrompt } from '../lib/useUnsavedChangesPrompt.js';
import { useModalDialog } from '../lib/useModalDialog.js';
import { useNewestFirst, usePagination } from '../lib/usePagination.js';
import Pagination from '../components/Pagination.jsx';

const MODEL_CATALOG_RETRY_LIMIT = 25;
const MODEL_CATALOG_RETRY_DELAY_MS = 1_000;

const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;

function normalizeGithubRepo(input) {
  const raw = (input ?? '').toString().trim();
  if (!raw) return '';
  if (GITHUB_REPO_RE.test(raw)) return raw.replace(/\.git$/, '');
  const ssh = /^git@github\.com:([^/]+)\/([^/#?]+?)(?:\.git)?$/.exec(raw);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  try {
    const withProtocol = raw.startsWith('github.com/') ? `https://${raw}` : raw;
    const u = new URL(withProtocol);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
    if (u.hostname !== 'github.com') return raw;
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length < 2) return raw;
    return `${segs[0]}/${segs[1].replace(/\.git$/, '')}`;
  } catch {
    return raw;
  }
}

function isValidRemoteRepo(input) {
  return GITHUB_REPO_RE.test(normalizeGithubRepo(input));
}

function formatRemoteRepoInput(input) {
  return isValidRemoteRepo(input) ? normalizeGithubRepo(input) : input;
}

const blankDependency = () => ({ kind: 'remote', repo_full: '', commit_sha: '' });

export function scanLaunchChoiceRequired(error) {
  return (
    error instanceof ApiError && error.status === 409 && error.errors?.some((item) => item?.field === 'launchPolicy')
  );
}

export default function CreateScan() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const duplicateFromId = params.get('from')?.trim() || '';
  const isDuplicating = Boolean(duplicateFromId);
  usePageChrome(
    [
      { label: 'Scans', to: '/scans' },
      { label: isDuplicating ? 'Duplicate configuration' : 'New scan', active: true },
    ],
    null,
    []
  );

  const [refData, setRefData] = useState(null);
  const [duplicateSource, setDuplicateSource] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [modelCatalogError, setModelCatalogError] = useState(null);
  const [modelCatalogRetryCount, setModelCatalogRetryCount] = useState(0);
  const [rankerPreviewOpen, setRankerPreviewOpen] = useState(false);
  const [agentSkillQuery, setAgentSkillQuery] = useState('');
  const [form, setForm] = useState({
    workflowId: '',
    postScriptId: '',
    postScriptIds: [],
    agentSkillIds: [],
    repoKind: 'remote',
    repoUrl: '',
    repoLocal: '',
    commit_sha: '',
    repo_scope: 'full repository',
    dependencies: [], // [{ kind, repo_full, commit_sha }]
    configuration: '{\n  "max_files": 4000,\n  "include_tests": false\n}',
    model: '',
    model_provider: '',
    harness: '',
    thinking_effort: 'medium',
    post_processing_model_override: false,
    post_processing_model: '',
    post_processing_model_provider: '',
    post_processing_harness: '',
    post_processing_thinking_effort: 'medium',
    model_overrides: {},
    extra: {},
    rankerIds: [],
    rankerExtra: '', // severity ranker: ordered ranker ids + per-scan custom rules
    jobLimit: '',
  });
  const [saving, setSaving] = useState(false);
  const [pendingScan, setPendingScan] = useState(null);
  const [serverErrors, setServerErrors] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [localRepoFileStats, setLocalRepoFileStats] = useState({
    repoName: '',
    status: 'idle',
    fileCount: null,
    complete: true,
    snapshotIssues: [],
    error: null,
  });
  const [localRepoFileStatsRetry, setLocalRepoFileStatsRetry] = useState(0);
  const { allow } = useUnsavedChangesPrompt(dirty || saving);

  useEffect(() => {
    const repoName = form.repoKind === 'local' ? form.repoLocal : '';
    if (!repoName) {
      setLocalRepoFileStats({
        repoName: '',
        status: 'idle',
        fileCount: null,
        complete: true,
        snapshotIssues: [],
        error: null,
      });
      return undefined;
    }

    let active = true;
    const controller = new AbortController();
    setLocalRepoFileStats({
      repoName,
      status: 'loading',
      fileCount: null,
      complete: true,
      snapshotIssues: [],
      error: null,
    });
    api
      .localRepoStats(repoName, { signal: controller.signal })
      .then((payload) => {
        if (!active) return;
        if (
          !Number.isSafeInteger(payload?.fileCount) ||
          payload.fileCount < 0 ||
          typeof payload.complete !== 'boolean' ||
          !Array.isArray(payload.snapshotIssues) ||
          payload.snapshotIssues.some((issue) => !['invalid_symlink', 'special_file'].includes(issue))
        ) {
          throw new Error('The local repository file count response was invalid.');
        }
        setLocalRepoFileStats({
          repoName,
          status: 'ready',
          fileCount: payload.fileCount,
          complete: payload.complete,
          snapshotIssues: [...new Set(payload.snapshotIssues)],
          error: null,
        });
      })
      .catch((error) => {
        if (!active || error?.name === 'AbortError') return;
        setLocalRepoFileStats({
          repoName,
          status: 'error',
          fileCount: null,
          complete: true,
          snapshotIssues: [],
          error,
        });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [form.repoKind, form.repoLocal, localRepoFileStatsRetry]);

  useEffect(() => {
    const duplicateSourceRequest = duplicateFromId
      ? /^\d+$/.test(duplicateFromId)
        ? api.scan(duplicateFromId)
        : Promise.reject(new Error('The source scan id is invalid.'))
      : Promise.resolve(null);
    Promise.all([
      api.workflows(),
      api.postScripts(),
      api.agentSkills(),
      api.severityRankers(),
      api.localRepos(),
      api.modelProviders(),
      api.modelCatalog().then(
        (catalog) => ({ catalog, error: null }),
        (error) => ({ catalog: null, error })
      ),
      duplicateSourceRequest,
    ])
      .then(
        ([
          workflows,
          postScripts,
          agentSkills,
          severityRankers,
          localRepos,
          modelProviders,
          catalogResult,
          sourceScan,
        ]) => {
          const configuredProviders = configuredModelProviders(modelProviders);
          const modelCatalog = configuredModelCatalog(catalogResult.catalog);
          setModelCatalogError(catalogResult.error);
          setModelCatalogRetryCount(0);
          setDuplicateSource(sourceScan);
          setRefData({
            workflows,
            postScripts,
            agentSkills,
            severityRankers,
            localRepos: localRepos || [],
            modelProviders: configuredProviders,
            modelCatalog,
          });
          setForm((f) => {
            if (sourceScan) {
              const duplicateDraft = scanConfigurationDraft(sourceScan);
              const duplicateWorkflow = workflows.find((workflow) => workflow.id === duplicateDraft.workflowId);
              return {
                ...f,
                ...duplicateDraft,
                model_overrides: reconcileModelOverrides(
                  duplicateDraft.model_overrides,
                  workflowDepths(duplicateWorkflow),
                  duplicateDraft
                ),
              };
            }
            const modelConfiguration = workflowModelConfigurationForCatalog(f, configuredProviders, modelCatalog);
            return {
              ...f,
              workflowId: defaultWorkflowId(workflows, params.get('workflow') || ''),
              postScriptId: postScripts[0]?.id || '',
              postScriptIds: postScripts[0]?.id ? [postScripts[0].id] : [],
              ...modelConfiguration,
              rankerIds: defaultRankerIds(severityRankers, f.rankerIds),
            };
          });
          if (sourceScan) setDirty(true);
        }
      )
      .catch(setLoadErr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeModelCatalog = refData?.modelCatalog;
  const modelReferencesLoaded = refData !== null;

  useEffect(() => {
    if (!refData || modelCatalogRetryCount >= MODEL_CATALOG_RETRY_LIMIT) return undefined;

    const needsCatalogRetry = refData.modelProviders.some(
      (provider) => !modelCatalogIsReady(refData.modelCatalog, provider)
    );
    if (!needsCatalogRetry) return undefined;

    const timer = setTimeout(() => {
      api
        .modelCatalog()
        .then((catalog) => {
          setRefData((current) => (current ? { ...current, modelCatalog: configuredModelCatalog(catalog) } : current));
          setModelCatalogError(null);
        })
        .catch(setModelCatalogError)
        .finally(() => setModelCatalogRetryCount((count) => count + 1));
    }, MODEL_CATALOG_RETRY_DELAY_MS);

    return () => clearTimeout(timer);
  }, [modelCatalogRetryCount, refData]);

  useEffect(() => {
    if (!modelReferencesLoaded) return undefined;
    let active = true;
    const refresh = () =>
      Promise.all([api.modelProviders(), api.modelCatalog()])
        .then(([providerPayload, catalogPayload]) => {
          if (!active) return;
          const modelProviders = configuredModelProviders(providerPayload);
          const modelCatalog = configuredModelCatalog(catalogPayload);
          setRefData((current) => (current ? { ...current, modelProviders, modelCatalog } : current));
          setModelCatalogError(null);
          if (!isDuplicating) {
            setForm((current) => ({
              ...current,
              ...workflowModelConfigurationForCatalog(current, modelProviders, modelCatalog),
            }));
          }
        })
        .catch((error) => active && setModelCatalogError(error));
    const timer = setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [isDuplicating, modelReferencesLoaded]);

  useEffect(() => {
    if (!activeModelCatalog || isDuplicating) return;

    setForm((f) => {
      const normalized = workflowModelConfigurationForCatalog(f, refData?.modelProviders || [], activeModelCatalog);
      if (
        normalized.model === f.model &&
        normalized.model_provider === f.model_provider &&
        normalized.thinking_effort === f.thinking_effort &&
        normalized.post_processing_model_override === f.post_processing_model_override &&
        normalized.post_processing_model === f.post_processing_model &&
        normalized.post_processing_model_provider === f.post_processing_model_provider &&
        normalized.post_processing_harness === f.post_processing_harness &&
        normalized.post_processing_thinking_effort === f.post_processing_thinking_effort &&
        normalized.harness === f.harness &&
        modelOverridesEqual(normalized.model_overrides, f.model_overrides)
      )
        return f;
      return { ...f, ...normalized };
    });
  }, [activeModelCatalog, isDuplicating, refData?.modelProviders]);

  const workflowOptions = useNewestFirst(refData?.workflows);
  const agentSkills = useNewestFirst(refData?.agentSkills);
  const filteredAgentSkills = useMemo(
    () => filterAgentSkills(agentSkills, agentSkillQuery),
    [agentSkillQuery, agentSkills]
  );
  const normalizedAgentSkillQuery = agentSkillQuery.trim().toLowerCase();
  const postScripts = useNewestFirst(refData?.postScripts);
  const severityRankers = useNewestFirst(refData?.severityRankers);
  const agentSkillPages = usePagination(filteredAgentSkills, { pageSize: 8, resetKey: normalizedAgentSkillQuery });
  const postScriptPages = usePagination(postScripts, { pageSize: 8 });
  const rankerPages = usePagination(severityRankers, { pageSize: 8 });

  if (loadErr)
    return (
      <div style={{ padding: 30 }}>
        <ErrorState error={loadErr} />
      </div>
    );
  if (!refData)
    return (
      <div style={{ padding: 30 }}>
        <Spinner />
      </div>
    );

  const set = (patch) => {
    setDirty(true);
    setForm((f) => ({ ...f, ...patch }));
  };
  const setExtra = (key, value) => {
    setDirty(true);
    setForm((f) => ({ ...f, extra: { ...f.extra, [key]: value } }));
  };
  const setWorkflow = (workflowId) => {
    const workflow = refData.workflows.find((candidate) => candidate.id === workflowId);
    setDirty(true);
    setForm((current) => ({
      ...current,
      workflowId,
      model_overrides: reconcileModelOverrides(current.model_overrides, workflowDepths(workflow), current),
    }));
  };

  // local repos as SearchSelect items (id = folder name)
  const localItems = refData.localRepos.map((r) => ({ id: r.name, ...r }));
  const localMeta = (r) => {
    if (!r) return '';
    const gitRef = r.isGit ? [r.branch || 'detached', r.commit].filter(Boolean).join(' ') : '';
    return gitRef ? `${gitRef} · folder snapshot` : 'folder snapshot';
  };

  const selectedWorkflow = refData.workflows.find((w) => w.id === form.workflowId);
  const selectedWorkflowDepths = workflowDepths(selectedWorkflow);
  const selectedPostScriptIds = form.postScriptIds?.length
    ? form.postScriptIds
    : form.postScriptId
      ? [form.postScriptId]
      : [];
  const expectedExtra = requiredScanExtraKeys(selectedWorkflow, refData.postScripts, selectedPostScriptIds);
  const modelProviders = refData.modelProviders;
  const hasConfiguredProvider = modelProviders.length > 0;
  const modelConfigurationValid = workflowModelConfigurationIsValid(
    form,
    selectedWorkflowDepths,
    modelProviders,
    refData.modelCatalog
  );
  const missingExtra = expectedExtra.filter((k) => !(form.extra[k] && form.extra[k].trim()));

  // Severity ranker: concatenate selected rankers' content (in selection order)
  // followed by the per-scan custom rules → the final severity_ranker string.
  const rankerContentById = (rid) => refData.severityRankers.find((r) => r.id === rid)?.content || '';
  const combinedRanker = combineSeverityRanker(form.rankerIds.map(rankerContentById), form.rankerExtra);
  const toggleScanRanker = (rid) => {
    setDirty(true);
    setForm((f) => ({
      ...f,
      rankerIds: f.rankerIds.includes(rid) ? f.rankerIds.filter((x) => x !== rid) : [...f.rankerIds, rid],
    }));
  };

  const repoUrlValid = isValidRemoteRepo(form.repoUrl.trim());
  const targetValid = form.repoKind === 'remote' ? repoUrlValid : !!form.repoLocal;

  const dependencyEmpty = (dep) => {
    if ((dep.kind || 'remote') === 'local') return !dep.repo_full;
    return !`${dep.repo_full || ''}`.trim() && !`${dep.commit_sha || ''}`.trim();
  };
  const dependencyValid = (dep) => {
    if (dependencyEmpty(dep)) return true;
    return (dep.kind || 'remote') === 'remote' ? isValidRemoteRepo(dep.repo_full) : !!dep.repo_full;
  };
  const dependenciesValid = form.dependencies.every(dependencyValid);
  const parsedJobLimit = Number(form.jobLimit);
  const jobLimitValid =
    !form.jobLimit.trim() || (/^\d+$/.test(form.jobLimit.trim()) && parsedJobLimit >= 1 && parsedJobLimit <= 1_000_000);
  const normalizedDependencies = () =>
    form.dependencies
      .filter((dep) => !dependencyEmpty(dep))
      .map((dep) =>
        (dep.kind || 'remote') === 'remote'
          ? {
              kind: 'remote',
              repo_full: normalizeGithubRepo(dep.repo_full),
              commit_sha: `${dep.commit_sha || ''}`.trim() || 'HEAD',
            }
          : { kind: 'local', repo_full: dep.repo_full, commit_sha: null }
      );

  const canCreate =
    hasConfiguredProvider &&
    modelConfigurationValid &&
    !!form.workflowId &&
    selectedPostScriptIds.length > 0 &&
    targetValid &&
    dependenciesValid &&
    jobLimitValid &&
    missingExtra.length === 0 &&
    !!combinedRanker.trim() &&
    !saving;

  const addDep = () => {
    setDirty(true);
    setForm((f) => ({ ...f, dependencies: [...f.dependencies, blankDependency()] }));
  };
  const updateDep = (idx, patch) => {
    setDirty(true);
    setForm((f) => ({
      ...f,
      dependencies: f.dependencies.map((dep, i) => (i === idx ? { ...dep, ...patch } : dep)),
    }));
  };
  const removeDep = (idx) => {
    setDirty(true);
    setForm((f) => ({ ...f, dependencies: f.dependencies.filter((_, i) => i !== idx) }));
  };
  const addDepOnEnter = (e, dep) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!dependencyEmpty(dep) && dependencyValid(dep)) addDep();
    }
  };

  const submitScan = async (payload) => {
    setSaving(true);
    setServerErrors([]);
    try {
      await api.createScan(payload);
      allow();
      navigate('/scans');
    } catch (e) {
      if (scanLaunchChoiceRequired(e) && !payload.launchPolicy) {
        setPendingScan(payload);
      } else if (e instanceof ApiError) {
        setServerErrors(e.errors?.map((x) => `${x.field}: ${x.message}`) || [e.message]);
      } else {
        setServerErrors([e.message]);
      }
      setSaving(false);
    }
  };

  const create = () => {
    if (!canCreate) return;
    let configuration = form.configuration;
    if (typeof form.configuration === 'string') {
      try {
        configuration = form.configuration.trim() ? JSON.parse(form.configuration) : {};
      } catch {
        configuration = form.configuration;
      }
    }
    if (configuration && typeof configuration === 'object' && !Array.isArray(configuration)) {
      configuration = { ...configuration, post_script_ids: selectedPostScriptIds, agent_skill_ids: form.agentSkillIds };
    }
    const payload = {
      workflowId: form.workflowId,
      postScriptId: selectedPostScriptIds[0],
      agentSkillIds: form.agentSkillIds,
      repo_kind: form.repoKind,
      repo_full: form.repoKind === 'remote' ? normalizeGithubRepo(form.repoUrl) : form.repoLocal,
      commit_sha: form.repoKind === 'remote' ? form.commit_sha.trim() || 'HEAD' : undefined,
      repo_scope: form.repo_scope,
      dependencies: normalizedDependencies(),
      configuration,
      model: form.model,
      model_provider: form.model_provider,
      harness: form.harness,
      thinking_effort: form.thinking_effort,
      ...(form.post_processing_model_override
        ? {
            post_processing_model: form.post_processing_model,
            post_processing_model_provider: form.post_processing_model_provider,
            post_processing_harness: form.post_processing_harness,
          }
        : {}),
      post_processing_thinking_effort: form.post_processing_thinking_effort,
      model_overrides: form.model_overrides,
      severity_ranker: combinedRanker,
      extra: form.extra,
      jobLimit: form.jobLimit.trim() ? Number(form.jobLimit) : null,
    };
    submitScan(payload);
  };

  const chooseLaunchPolicy = (launchPolicy) => {
    if (!pendingScan || saving) return;
    const payload = { ...pendingScan, launchPolicy };
    setPendingScan(null);
    submitScan(payload);
  };

  const blockedLabel = !hasConfiguredProvider
    ? 'Add a provider in Accounts'
    : !modelConfigurationValid
      ? 'Complete the model configuration'
      : !form.workflowId
        ? 'Select a workflow'
        : selectedPostScriptIds.length === 0
          ? 'Select a post-script'
          : !targetValid
            ? form.repoKind === 'remote'
              ? 'Enter a valid repo'
              : 'Select a local repository'
            : !dependenciesValid
              ? 'Fix dependency rows'
              : !jobLimitValid
                ? 'Fix maximum model jobs'
                : missingExtra.length
                  ? `Fill ${missingExtra.length} required extra`
                  : !combinedRanker.trim()
                    ? 'Add severity ranking rules'
                    : 'Create scan';

  const togglePostScript = (id) => {
    setDirty(true);
    setForm((f) => {
      const current = f.postScriptIds?.length ? f.postScriptIds : f.postScriptId ? [f.postScriptId] : [];
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      return { ...f, postScriptIds: next, postScriptId: next[0] || '' };
    });
  };
  const toggleAgentSkill = (id) => {
    setDirty(true);
    setForm((f) => {
      const current = f.agentSkillIds || [];
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      return { ...f, agentSkillIds: next };
    });
  };

  return (
    <div
      className="create-scan-page"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div className="create-scan-body" style={{ flex: 1, overflowY: 'auto', padding: '30px 32px' }}>
        <div className="create-scan-content" style={{ maxWidth: 780 }}>
          <div style={{ fontSize: 25, fontWeight: 600, letterSpacing: '-0.02em' }}>
            {isDuplicating ? 'Duplicate scan configuration' : 'New scan'}
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-2)', margin: '3px 0 26px' }}>
            {isDuplicating
              ? 'Review the copied configuration, make any changes, then create a new scan.'
              : 'Point a workflow at a repository. The engine queues it and runs every step.'}
          </div>

          {duplicateSource && (
            <div
              role="note"
              style={{
                border: '1px solid var(--accent)',
                borderRadius: 10,
                padding: '12px 14px',
                background: 'var(--accent-subtle)',
                color: 'var(--text-2)',
                fontSize: 12.5,
                lineHeight: 1.5,
                marginBottom: 24,
              }}
            >
              Configuration copied from{' '}
              <Link to={`/scans/${duplicateSource.id}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>
                {duplicateSource.repoDisplay || duplicateSource.repoFull || `scan ${duplicateSource.id}`}
              </Link>
              . Results, logs, status, attempts, and timestamps are not copied.
            </div>
          )}

          <Label>1 · WORKFLOW</Label>
          <div style={{ marginBottom: 28 }}>
            <SearchSelect
              items={workflowOptions}
              value={form.workflowId}
              onChange={setWorkflow}
              placeholder="Search workflows…"
              renderTrigger={(w) => (
                <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <span className="mono" style={{ fontWeight: 600, fontSize: 14 }}>
                    {w?.name || 'Select workflow'}
                  </span>
                  {w && (
                    <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                      {w.stepCount} steps
                    </span>
                  )}
                </span>
              )}
              renderItem={(w) => (
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>
                      {w.name}
                    </span>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                      {w.stepCount} steps
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3 }}>{w.description}</div>
                </div>
              )}
              filter={(w, q) => w.name.toLowerCase().includes(q) || (w.description || '').toLowerCase().includes(q)}
            />
          </div>

          {/* ===================== TARGET ===================== */}
          <Label>2 · TARGET</Label>
          <Pills
            value={form.repoKind}
            onChange={(k) => set({ repoKind: k })}
            options={[
              ['remote', 'Remote'],
              ['local', 'Local'],
            ]}
          />

          {form.repoKind === 'remote' ? (
            <div
              className="create-scan-two-column"
              style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 12 }}
            >
              <Field label="repository">
                <Input
                  value={form.repoUrl}
                  onChange={(e) => set({ repoUrl: e.target.value })}
                  onBlur={() => set({ repoUrl: formatRemoteRepoInput(form.repoUrl) })}
                  placeholder="https://github.com/org/repo"
                  mono
                  style={{ borderColor: form.repoUrl && !repoUrlValid ? 'var(--fail)' : 'var(--border)' }}
                />
                {form.repoUrl && !repoUrlValid && <FieldError>Use owner/repo or a GitHub URL.</FieldError>}
              </Field>
              <Field label="commit_sha">
                <Input
                  value={form.commit_sha}
                  onChange={(e) => set({ commit_sha: e.target.value })}
                  placeholder="HEAD"
                  mono
                />
              </Field>
            </div>
          ) : (
            <div style={{ marginBottom: 12 }}>
              <Field label="local repository">
                <SearchSelect
                  height={38}
                  items={localItems}
                  value={form.repoLocal}
                  onChange={(name) => set({ repoLocal: name })}
                  placeholder="Search local repos…"
                  emptyText="No local repos found under the configured root."
                  renderTrigger={(r) => (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                      <span className="mono" style={{ fontSize: 13, color: r ? 'var(--text)' : 'var(--text-3)' }}>
                        {r?.name || 'Select a local repository'}
                      </span>
                      {r && (
                        <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                          {localMeta(r)}
                        </span>
                      )}
                    </span>
                  )}
                  renderItem={(r) => (
                    <div style={{ minWidth: 0 }}>
                      <div className="mono" style={{ fontWeight: 600, fontSize: 12.5 }}>
                        {r.name}
                      </div>
                      <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 2 }}>
                        {r.path} · {localMeta(r) || 'not a git repo'}
                      </div>
                    </div>
                  )}
                  filter={(r, q) => r.name.toLowerCase().includes(q)}
                />
              </Field>
              <LocalRepoFilePreflight
                stats={localRepoFileStats}
                repoName={form.repoLocal}
                configuration={form.configuration}
                onRetry={() => setLocalRepoFileStatsRetry((attempt) => attempt + 1)}
              />
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 7,
                  fontSize: 11.5,
                  color: 'var(--text-3)',
                  marginTop: 7,
                  lineHeight: 1.5,
                }}
              >
                <span style={{ flex: 'none' }}>ⓘ</span>
                At scan start, open·kritt takes one snapshot of this folder, including modified and untracked files but
                excluding .git. Git is not required. The selected model provider receives the snapshot contents; create
                a new scan to capture later changes.
              </div>
            </div>
          )}

          <div style={{ marginBottom: 28 }}>
            <Field label="repo_scope">
              <Input value={form.repo_scope} onChange={(e) => set({ repo_scope: e.target.value })} />
            </Field>
          </div>

          {/* ===================== DEPENDENCIES ===================== */}
          <Label>
            3 · DEPENDENCIES{' '}
            <span style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--text-3)' }}>
              · optional · scanned alongside the target
            </span>
          </Label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
            {form.dependencies.map((dep, i) => (
              <div
                key={i}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 11,
                  background: 'var(--surface-2)',
                  padding: 14,
                }}
              >
                <div
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}
                >
                  <Pills
                    small
                    value={dep.kind || 'remote'}
                    onChange={(kind) => updateDep(i, { kind, repo_full: '', commit_sha: '' })}
                    options={[
                      ['remote', 'Remote'],
                      ['local', 'Local'],
                    ]}
                    noMargin
                  />
                  <button
                    type="button"
                    onClick={() => removeDep(i)}
                    aria-label={`Remove dependency ${i + 1}`}
                    style={{
                      color: 'var(--text-3)',
                      fontSize: 18,
                      cursor: 'pointer',
                      lineHeight: 1,
                      border: 0,
                      background: 'transparent',
                      padding: 4,
                    }}
                  >
                    ×
                  </button>
                </div>
                {(dep.kind || 'remote') === 'remote' ? (
                  <div
                    className="create-scan-two-column"
                    style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}
                  >
                    <Field label="dependency repository" small>
                      <Input
                        value={dep.repo_full || ''}
                        onChange={(e) => updateDep(i, { repo_full: e.target.value })}
                        onBlur={() => updateDep(i, { repo_full: formatRemoteRepoInput(dep.repo_full) })}
                        onKeyDown={(e) => addDepOnEnter(e, dep)}
                        placeholder="org/lib"
                        mono
                        small
                        style={{
                          borderColor:
                            dep.repo_full && !isValidRemoteRepo(dep.repo_full) ? 'var(--fail)' : 'var(--border)',
                        }}
                      />
                      {dep.repo_full && !isValidRemoteRepo(dep.repo_full) && (
                        <FieldError>Use owner/repo or a GitHub URL.</FieldError>
                      )}
                    </Field>
                    <Field label="commit_sha" small>
                      <Input
                        value={dep.commit_sha || ''}
                        onChange={(e) => updateDep(i, { commit_sha: e.target.value })}
                        onKeyDown={(e) => addDepOnEnter(e, dep)}
                        placeholder="HEAD"
                        mono
                        small
                      />
                    </Field>
                  </div>
                ) : (
                  <div>
                    <Field label="local repository" small>
                      <SearchSelect
                        height={36}
                        items={localItems}
                        value={dep.repo_full || ''}
                        onChange={(name) => updateDep(i, { repo_full: name, commit_sha: null })}
                        placeholder="Search local repos…"
                        emptyText="No local repos found."
                        renderTrigger={(r) => (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                            <span
                              className="mono"
                              style={{ fontSize: 12.5, color: r ? 'var(--text)' : 'var(--text-3)' }}
                            >
                              {r?.name || 'Select a local repository'}
                            </span>
                            {r && (
                              <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                                {localMeta(r)}
                              </span>
                            )}
                          </span>
                        )}
                        renderItem={(r) => (
                          <div style={{ minWidth: 0 }}>
                            <div className="mono" style={{ fontWeight: 600, fontSize: 12 }}>
                              {r.name}
                            </div>
                            <div className="mono" style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                              {r.path} · {localMeta(r)}
                            </div>
                          </div>
                        )}
                        filter={(r, q) => r.name.toLowerCase().includes(q)}
                      />
                    </Field>
                    <div style={{ marginTop: 5, fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-3)' }}>
                      Snapshotted once with the target when the scan starts. A new scan captures later changes.
                    </div>
                  </div>
                )}
              </div>
            ))}
            {form.dependencies.length === 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '2px 2px 4px' }}>
                No dependencies added.
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={addDep}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              height: 36,
              padding: '0 15px',
              border: '1px dashed var(--border)',
              borderRadius: 9,
              fontSize: 12.5,
              color: 'var(--text-2)',
              cursor: 'pointer',
              marginBottom: 28,
              background: 'transparent',
              font: 'inherit',
            }}
          >
            + add dependency
          </button>

          {/* ===================== CONFIGURATION ===================== */}
          <Label>4 · CONFIGURATION</Label>
          <div style={{ marginBottom: 28 }}>
            <textarea
              value={form.configuration}
              onChange={(e) => set({ configuration: e.target.value })}
              spellCheck={false}
              className="mono"
              style={{
                width: '100%',
                height: 88,
                padding: 12,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--code-bg)',
                color: 'var(--text)',
                fontSize: 12,
                lineHeight: 1.6,
                outline: 'none',
                resize: 'vertical',
              }}
            />
            <div style={{ marginTop: 12, maxWidth: 280 }}>
              <Field label="maximum model jobs · optional">
                <Input
                  value={form.jobLimit}
                  onChange={(e) => set({ jobLimit: e.target.value })}
                  type="number"
                  min="1"
                  max="1000000"
                  step="1"
                  placeholder="unlimited"
                  mono
                  style={{ borderColor: jobLimitValid ? 'var(--border)' : 'var(--fail)' }}
                />
                <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--text-3)', marginTop: 6 }}>
                  Exact cap across workflow and post-processing jobs. Internal retries do not consume extra jobs.
                </div>
                {!jobLimitValid && <FieldError>Enter a whole number from 1 to 1,000,000.</FieldError>}
              </Field>
            </div>
          </div>

          {/* ===================== EXTRA ===================== */}
          <Label>5 · EXTRA</Label>
          <div style={{ marginBottom: 28 }}>
            {expectedExtra.length > 0 ? (
              <>
                <div style={{ fontSize: 12.5, color: 'var(--text-2)', margin: '-4px 0 12px' }}>
                  The selected workflow and post-scripts reference{' '}
                  <span className="mono" style={{ color: 'var(--accent)' }}>
                    {'{{extra.…}}'}
                  </span>{' '}
                  keys. Provide a value for each.
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
                  {expectedExtra.map((k) => (
                    <Field key={k} label={`extra.${k}`}>
                      <textarea
                        value={form.extra[k] || ''}
                        onChange={(e) => setExtra(k, e.target.value)}
                        placeholder="required"
                        spellCheck={false}
                        className="mono"
                        style={{
                          width: '100%',
                          minHeight: 180,
                          padding: 12,
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          background: 'var(--code-bg)',
                          color: 'var(--text)',
                          fontSize: 12,
                          lineHeight: 1.6,
                          outline: 'none',
                          resize: 'vertical',
                          borderColor: form.extra[k] && form.extra[k].trim() ? 'var(--border)' : 'var(--fail)',
                        }}
                      />
                    </Field>
                  ))}
                </div>
              </>
            ) : (
              <div
                style={{
                  fontSize: 12.5,
                  color: 'var(--text-3)',
                  border: '1px dashed var(--border)',
                  borderRadius: 8,
                  padding: '12px 14px',
                }}
              >
                {selectedWorkflow ? (
                  <>
                    The selected workflow and post-scripts don’t reference any{' '}
                    <span className="mono">{'{{extra.…}}'}</span> keys — nothing to fill in here.
                  </>
                ) : (
                  'Select a workflow to see its extra keys.'
                )}
              </div>
            )}
          </div>

          {/* ===================== MODEL & HARNESS ===================== */}
          <Label>6 · MODEL &amp; HARNESS</Label>
          <div style={{ marginBottom: 28 }}>
            <WorkflowModelConfiguration
              value={form}
              onChange={(configuration) => {
                setDirty(true);
                setForm((current) => ({ ...current, ...configuration }));
              }}
              providers={modelProviders}
              catalog={refData.modelCatalog}
              catalogError={modelCatalogError}
              depths={selectedWorkflowDepths}
              depthChips={selectedWorkflow?.depthChips || []}
            />
          </div>

          {/* ===================== AGENT SKILLS ===================== */}
          <Label>
            7 · AGENT SKILLS{' '}
            <span style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--text-3)' }}>· optional</span>
          </Label>
          {agentSkills.length > 0 && (
            <AgentSkillSearchInput
              value={agentSkillQuery}
              onChange={setAgentSkillQuery}
              listId="create-scan-agent-skills"
            />
          )}
          <div
            id="create-scan-agent-skills"
            role="group"
            aria-label="Agent skills"
            style={{
              border: '1px solid var(--border)',
              borderRadius: 10,
              background: 'var(--surface)',
              overflowY: 'auto',
              maxHeight: 360,
              marginBottom: 8,
            }}
          >
            {agentSkillPages.pageItems.map((skill) => {
              const active = form.agentSkillIds.includes(skill.id);
              return (
                <div
                  key={skill.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    borderBottom: '1px solid var(--border-2)',
                    background: active ? 'var(--accent-subtle)' : 'transparent',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggleAgentSkill(skill.id)}
                    aria-pressed={active}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 11,
                      padding: '11px 13px',
                      cursor: 'pointer',
                      border: 0,
                      background: 'transparent',
                      color: 'inherit',
                      flex: 1,
                      minWidth: 0,
                      font: 'inherit',
                      textAlign: 'left',
                    }}
                  >
                    <span
                      className="mono"
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 5,
                        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                        background: active ? 'var(--accent)' : 'var(--surface)',
                        color: 'var(--accent-fg)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                        flex: 'none',
                        marginTop: 1,
                      }}
                    >
                      {active ? '✓' : ''}
                    </span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="mono" style={{ fontWeight: 600, fontSize: 13 }}>
                        {skill.name}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3 }}>{skill.description}</div>
                      <div
                        className="mono"
                        style={{
                          fontSize: 10.5,
                          color: 'var(--text-3)',
                          marginTop: 4,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {[skill.slug, skill.licenseSpdx].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                  </button>
                  {skill.sourceUrl && (
                    <a
                      href={skill.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        height: 21,
                        padding: '0 8px',
                        margin: '11px 13px 0 0',
                        borderRadius: 6,
                        border: '1px solid var(--accent)',
                        background: 'var(--accent-subtle)',
                        color: 'var(--accent)',
                        fontWeight: 700,
                        fontSize: 10.5,
                        textDecoration: 'none',
                        cursor: 'pointer',
                        flex: 'none',
                      }}
                    >
                      source
                    </a>
                  )}
                </div>
              );
            })}
            {agentSkills.length === 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--text-3)', padding: 13 }}>No agent skills defined.</div>
            )}
            {agentSkills.length > 0 && filteredAgentSkills.length === 0 && (
              <div role="status" aria-live="polite" style={{ fontSize: 12.5, color: 'var(--text-3)', padding: 13 }}>
                No agent skills match “{agentSkillQuery.trim()}”.
              </div>
            )}
          </div>
          <Pagination {...agentSkillPages} itemLabel="skills" compact />
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 28 }}>
            {form.agentSkillIds.length} selected.
            {agentSkillQuery.trim() ? ` ${filteredAgentSkills.length} of ${agentSkills.length} skills match. ` : ' '}
            Selected skills are installed into each executor agent for this scan.
          </div>

          {/* ===================== POST-SCRIPT ===================== */}
          <Label>8 · POST-SCRIPTS</Label>
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 10,
              background: 'var(--surface)',
              overflowY: 'auto',
              maxHeight: 360,
            }}
          >
            {postScriptPages.pageItems.map((p) => {
              const active = selectedPostScriptIds.includes(p.id);
              return (
                <button
                  type="button"
                  key={p.id}
                  onClick={() => togglePostScript(p.id)}
                  aria-pressed={active}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 11,
                    padding: '11px 13px',
                    cursor: 'pointer',
                    borderBottom: '1px solid var(--border-2)',
                    borderTop: 0,
                    borderLeft: 0,
                    borderRight: 0,
                    background: active ? 'var(--accent-subtle)' : 'transparent',
                    width: '100%',
                    color: 'inherit',
                    font: 'inherit',
                    textAlign: 'left',
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 5,
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                      background: active ? 'var(--accent)' : 'var(--surface)',
                      color: 'var(--accent-fg)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      flex: 'none',
                      marginTop: 1,
                    }}
                  >
                    {active ? '✓' : ''}
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="mono" style={{ fontWeight: 600, fontSize: 13 }}>
                      {p.name}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3 }}>{p.description}</div>
                    {(p.keys || []).length > 0 && (
                      <div
                        className="mono"
                        style={{
                          fontSize: 10.5,
                          color: 'var(--text-3)',
                          marginTop: 4,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {p.keys.join(' · ')}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          <Pagination {...postScriptPages} itemLabel="post-scripts" compact />
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 7 }}>
            {selectedPostScriptIds.length} selected. The first selected script is stored as the scan primary; all
            selected scripts run after ranking.
          </div>

          {/* ===================== SEVERITY RANKER ===================== */}
          <Label style={{ marginTop: 28 }}>9 · SEVERITY RANKER</Label>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 12 }}>
            Pick any number of rankers — their rules are concatenated, then your scan-specific rules are appended.
          </div>
          <div
            className="create-scan-ranker-grid"
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}
          >
            {rankerPages.pageItems.map((r) => {
              const on = form.rankerIds.includes(r.id);
              const order = on ? form.rankerIds.indexOf(r.id) + 1 : '';
              return (
                <button
                  type="button"
                  key={r.id}
                  onClick={() => toggleScanRanker(r.id)}
                  aria-pressed={on}
                  style={{
                    border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                    background: on ? 'var(--accent-subtle)' : 'var(--surface)',
                    borderRadius: 10,
                    padding: '13px 14px',
                    cursor: 'pointer',
                    display: 'flex',
                    gap: 11,
                    alignItems: 'flex-start',
                    width: '100%',
                    color: 'inherit',
                    font: 'inherit',
                    textAlign: 'left',
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 6,
                      border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                      background: on ? 'var(--accent)' : 'transparent',
                      color: on ? 'var(--accent-fg)' : 'var(--text-3)',
                      flex: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 10.5,
                      fontWeight: 600,
                      marginTop: 1,
                    }}
                  >
                    {order}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="mono" style={{ fontWeight: 600, fontSize: 13 }}>
                      {r.name}
                      {r.isDefault ? (
                        <span style={{ color: 'var(--accent)', fontSize: 10.5, marginLeft: 7 }}>default</span>
                      ) : null}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 3, lineHeight: 1.45 }}>
                      {r.description}
                    </div>
                  </div>
                </button>
              );
            })}
            {refData.severityRankers.length === 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '2px 0' }}>
                No saved rankers — add scan-specific rules below, or create one under Severity rankers.
              </div>
            )}
          </div>
          <Pagination {...rankerPages} itemLabel="rankers" compact style={{ marginBottom: 16 }} />

          <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-2)', marginBottom: 5 }}>
            scan-specific rules <span style={{ color: 'var(--text-3)' }}>· optional · markdown</span>
          </div>
          <textarea
            value={form.rankerExtra}
            onChange={(e) => set({ rankerExtra: e.target.value })}
            spellCheck={false}
            placeholder="e.g. Treat anything reachable from the public checkout flow as at least High."
            className="mono"
            style={{
              width: '100%',
              height: 84,
              padding: 12,
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--code-bg)',
              color: 'var(--text)',
              fontSize: 12,
              lineHeight: 1.6,
              outline: 'none',
              resize: 'vertical',
            }}
          />

          <div
            style={{
              marginTop: 12,
              border: '1px solid var(--border)',
              borderRadius: 9,
              background: 'var(--surface)',
              overflow: 'hidden',
            }}
          >
            <button
              type="button"
              onClick={() => setRankerPreviewOpen((o) => !o)}
              aria-expanded={rankerPreviewOpen}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '11px 14px',
                cursor: 'pointer',
                width: '100%',
                border: 0,
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                textAlign: 'left',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5, color: 'var(--text)' }}>
                <span style={{ color: 'var(--text-3)', fontSize: 10 }}>{rankerPreviewOpen ? '▾' : '▸'}</span>
                Combined ruleset{' '}
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                  severity_ranker
                </span>
              </span>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                {form.rankerIds.length} ranker{form.rankerIds.length === 1 ? '' : 's'}
                {form.rankerExtra.trim() ? ' + custom rules' : ''} ·{' '}
                {combinedRanker.length ? `${combinedRanker.length} chars` : 'empty'}
              </span>
            </button>
            {rankerPreviewOpen && (
              <div
                style={{
                  borderTop: '1px solid var(--border-2)',
                  padding: '16px 18px',
                  background: 'var(--bg)',
                  maxHeight: 300,
                  overflowY: 'auto',
                }}
              >
                {combinedRanker.trim() ? (
                  <Markdown source={combinedRanker} />
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
                    No rules selected yet. Add a ranker or scan-specific rules.
                  </div>
                )}
              </div>
            )}
          </div>

          {serverErrors.length > 0 && (
            <div style={{ marginTop: 18, color: 'var(--fail)', fontSize: 12.5 }}>{serverErrors.join(' · ')}</div>
          )}
        </div>
      </div>

      {pendingScan && (
        <ScanLaunchDialog saving={saving} onClose={() => setPendingScan(null)} onChoose={chooseLaunchPolicy} />
      )}

      <div
        className="create-scan-footer"
        style={{
          flex: 'none',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg)',
          padding: '13px 32px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
        }}
      >
        <button
          type="button"
          className="create-scan-submit"
          onClick={create}
          disabled={!canCreate}
          style={{
            height: 36,
            padding: '0 20px',
            display: 'flex',
            alignItems: 'center',
            borderRadius: 9,
            fontSize: 13.5,
            fontWeight: 500,
            cursor: canCreate ? 'pointer' : 'default',
            border: 0,
            background: canCreate ? 'var(--accent)' : 'var(--surface-2)',
            color: canCreate ? 'var(--accent-fg)' : 'var(--text-3)',
          }}
        >
          {saving ? 'Creating…' : canCreate ? 'Create scan' : blockedLabel}
        </button>
      </div>
    </div>
  );
}

// ---- small building blocks ----
export function AgentSkillSearchInput({ value, onChange, listId }) {
  return (
    <div style={{ position: 'relative', marginBottom: 8 }}>
      <Input
        type="text"
        role="searchbox"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          onChange('');
        }}
        aria-label="Search agent skills"
        aria-controls={listId}
        autoComplete="off"
        maxLength={200}
        placeholder="Search by name, slug, description, or license…"
        mono
        style={{ height: 36, paddingRight: value ? 34 : 12 }}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear agent skill search"
          title="Clear search"
          style={{
            position: 'absolute',
            top: '50%',
            right: 8,
            transform: 'translateY(-50%)',
            width: 24,
            height: 24,
            border: 0,
            borderRadius: 6,
            background: 'transparent',
            color: 'var(--text-3)',
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

export function LocalRepoFilePreflight({ stats, repoName, configuration, onRetry }) {
  const visibleStats = repoName && stats?.repoName !== repoName ? { status: 'loading' } : stats;
  if (!visibleStats || visibleStats.status === 'idle') return null;

  const panelStyle = {
    border: '1px solid var(--border)',
    borderRadius: 9,
    padding: '11px 12px',
    marginTop: 9,
    background: 'var(--surface-2)',
    fontSize: 12,
    lineHeight: 1.45,
  };

  if (visibleStats.status === 'loading') {
    return (
      <div role="status" aria-live="polite" className="mono" style={{ ...panelStyle, color: 'var(--text-2)' }}>
        Counting snapshot files…
      </div>
    );
  }

  if (visibleStats.status === 'error') {
    return (
      <div role="status" aria-live="polite" style={{ ...panelStyle, borderColor: 'var(--pend)' }}>
        <div style={{ color: 'var(--text-2)' }}>
          Couldn’t count files. You can still create the scan, but the preflight check is unavailable.
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="mono"
          style={{
            border: 0,
            background: 'transparent',
            color: 'var(--accent)',
            cursor: 'pointer',
            padding: '5px 0 0',
            fontSize: 11.5,
            fontWeight: 600,
          }}
        >
          Retry count
        </button>
      </div>
    );
  }

  const preflight = localRepoFilePreflight(visibleStats.fileCount, configuredMaxFiles(configuration), {
    complete: visibleStats.complete,
  });
  if (!preflight) return null;

  const overLimit = preflight.kind === 'over_limit';
  const atLimit = preflight.kind === 'at_limit';
  const invalidSymlink = visibleStats.snapshotIssues?.includes('invalid_symlink');
  const specialFile = visibleStats.snapshotIssues?.includes('special_file');
  const snapshotIncompatible = invalidSymlink || specialFile;
  const progress =
    preflight.maxFiles && (preflight.complete || preflight.isOverLimit)
      ? Math.min(100, Math.max(0, (preflight.fileCount / preflight.maxFiles) * 100))
      : null;
  const tone = overLimit || snapshotIncompatible ? 'var(--fail)' : atLimit ? 'var(--pend)' : 'var(--accent)';

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        ...panelStyle,
        borderColor: overLimit || snapshotIncompatible ? 'var(--fail)' : 'var(--border)',
        background: overLimit || snapshotIncompatible ? 'var(--fail-bg)' : 'var(--surface-2)',
      }}
    >
      <div
        className="mono"
        style={{ color: overLimit || snapshotIncompatible ? 'var(--fail)' : 'var(--text)', fontWeight: 600 }}
      >
        {preflight.summary}
      </div>
      {progress !== null && (
        <div
          data-file-count-progress
          aria-hidden="true"
          style={{ height: 4, borderRadius: 999, background: 'var(--border)', overflow: 'hidden', margin: '8px 0' }}
        >
          <div style={{ width: `${progress}%`, height: '100%', borderRadius: 999, background: tone }} />
        </div>
      )}
      {snapshotIncompatible && (
        <div style={{ color: 'var(--fail)', fontWeight: 600, marginTop: progress === null ? 7 : 0 }}>
          This folder contains{' '}
          {invalidSymlink && specialFile
            ? 'absolute or out-of-root symlinks and unsupported special files'
            : invalidSymlink
              ? 'one or more absolute or out-of-root symlinks'
              : 'one or more unsupported special files'}
          . The engine cannot safely snapshot it, so the scan is expected to fail unless the incompatible entries are
          removed.
        </div>
      )}
      <div style={{ color: 'var(--text-2)', marginTop: snapshotIncompatible ? 5 : 0 }}>{preflight.detail}</div>
      <div style={{ color: 'var(--text-3)', fontSize: 10.5, marginTop: 4 }}>
        This count reflects the folder now; the fixed scan snapshot is taken when the scan starts.
      </div>
    </div>
  );
}

export function ScanLaunchDialog({ saving = false, onClose, onChoose }) {
  const dialogRef = useModalDialog(onClose);

  return (
    <div
      role="presentation"
      onMouseDown={() => !saving && onClose()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(0,0,0,.32)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="scan-launch-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          width: 500,
          maxWidth: '100%',
          padding: 22,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: '0 18px 50px rgba(0,0,0,.28)',
        }}
      >
        <div id="scan-launch-title" style={{ fontSize: 17, fontWeight: 600 }}>
          A scan is already running
        </div>
        <div style={{ marginTop: 8, color: 'var(--text-2)', fontSize: 13.5, lineHeight: 1.55 }}>
          Start this scan in the concurrent pool, or place it behind immediate scans until capacity is available.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 22 }}>
          <Button variant="ghost" disabled={saving} onClick={() => onChoose('queue')}>
            Queue
          </Button>
          <Button data-autofocus disabled={saving} onClick={() => onChoose('immediate')}>
            {saving ? 'Creating…' : 'Start immediately'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Label({ children, style }) {
  return (
    <div
      className="mono"
      style={{ fontSize: 10, letterSpacing: '0.07em', color: 'var(--text-3)', marginBottom: 10, ...style }}
    >
      {children}
    </div>
  );
}
function Field({ label, children, small }) {
  return (
    <div>
      <div className="mono" style={{ fontSize: small ? 11 : 11.5, color: 'var(--text-2)', marginBottom: 5 }}>
        {label}
      </div>
      {children}
    </div>
  );
}
function FieldError({ children }) {
  return (
    <div className="mono" style={{ fontSize: 10.5, color: 'var(--fail)', marginTop: 5 }}>
      {children}
    </div>
  );
}
function Input({ mono, small, style, ...props }) {
  return (
    <input
      {...props}
      spellCheck={false}
      className={mono ? 'mono' : undefined}
      style={{
        width: '100%',
        height: small ? 36 : 38,
        padding: '0 12px',
        border: '1px solid var(--border)',
        borderRadius: small ? 7 : 8,
        background: 'var(--surface)',
        color: 'var(--text)',
        fontSize: small ? 12.5 : 13,
        outline: 'none',
        ...style,
      }}
    />
  );
}
function Pills({ value, onChange, options, small, noMargin }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        background: small ? 'var(--bg)' : 'var(--surface-2)',
        border: small ? '1px solid var(--border)' : 'none',
        borderRadius: small ? 8 : 9,
        padding: 3,
        marginBottom: noMargin ? 0 : 14,
      }}
    >
      {options.map(([val, label]) => {
        const active = value === val;
        return (
          <button
            type="button"
            key={val}
            onClick={() => onChange(val)}
            aria-pressed={active}
            style={{
              fontSize: small ? 12 : 12.5,
              padding: small ? '5px 12px' : '6px 14px',
              borderRadius: small ? 6 : 7,
              border: 0,
              cursor: 'pointer',
              background: active ? 'var(--surface)' : 'transparent',
              color: active ? 'var(--text)' : 'var(--text-2)',
              boxShadow: active ? 'var(--shadow)' : 'none',
              font: 'inherit',
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
