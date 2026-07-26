import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import ModelConfiguration, {
  modelConfigurationForCatalog,
  modelConfigurationIsValid,
} from '../components/ModelConfiguration.jsx';
import { Spinner } from '../components/ui.jsx';
import { usePageChrome } from '../context/ui.jsx';
import { configuredModelCatalog, configuredModelProviders, modelCatalogIsReady } from '../lib/modelProviders.js';
import {
  GENERATION_POLL_FAILURE_LIMIT,
  generationIsRunning,
  generationPollErrorIsTerminal,
  generationPollShouldRetry,
} from '../lib/generationPolling.js';
import { apiErrorMessages, generationFailureViewModel } from '../lib/generationFailure.js';

const MODEL_CATALOG_RETRY_LIMIT = 25;
const MODEL_CATALOG_RETRY_DELAY_MS = 1_000;
const GENERATION_POLL_MS = 1_500;

const COPY = {
  workflow: {
    label: 'workflow',
    plural: 'Workflows',
    listPath: '/workflows',
    editorPath: '/workflows/new',
    title: 'Generate a workflow with AI',
    subtitle: 'Describe the security research process you want. You will review the generated draft before saving it.',
    guidance:
      'Include the objective, the stages and their order, what each stage should produce, any sibling or fan-out behavior, constraints and exclusions, and values scan users should supply through extra.<key>.',
    placeholder:
      'I want a two-stage workflow. First, discover every externally reachable entrypoint available to an unauthenticated actor. Then investigate each entrypoint for specific impacts. Create one sibling research step per impact, supplied at scan time through extra values. Each research step should trace the complete flow and report only concrete, exploitable vulnerabilities…',
  },
  post_script: {
    label: 'post-script',
    plural: 'Post-scripts',
    listPath: '/post-scripts',
    editorPath: '/post-scripts/new',
    title: 'Generate a post-script with AI',
    subtitle:
      'Describe how findings should be enriched or graded. You will review the generated draft before saving it.',
    guidance:
      'Include the evaluation criteria, desired output fields and types, edge cases, and whether results should add up to three _chip_ values, a detailed _reserved_report, or a _reserved_poc section.',
    placeholder:
      'For every finding, assess exploitability and likely impact. Add compact chips for exploitability and confidence, explain the decision with evidence from the finding, and produce a detailed markdown report only when the issue is exploitable…',
  },
};

export default function AiGeneration({ kind }) {
  const copy = COPY[kind];
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const generationId = searchParams.get('job');

  const [request, setRequest] = useState('');
  const [modelConfiguration, setModelConfiguration] = useState({
    model: '',
    model_provider: '',
    harness: '',
    thinking_effort: 'medium',
  });
  const [referenceData, setReferenceData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [catalogError, setCatalogError] = useState(null);
  const [catalogRetryCount, setCatalogRetryCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitErrors, setSubmitErrors] = useState([]);
  const [job, setJob] = useState(null);
  const [pollError, setPollError] = useState(null);
  const [pollPaused, setPollPaused] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);

  usePageChrome(
    [
      { label: copy.plural, to: copy.listPath },
      { label: `Generate ${copy.label}`, active: true },
    ],
    null,
    [kind]
  );

  useEffect(() => {
    let active = true;
    let hasLoaded = false;
    const refresh = () =>
      Promise.all([
        api.modelProviders(),
        api.modelCatalog().then(
          (catalog) => ({ catalog, error: null }),
          (error) => ({ catalog: null, error })
        ),
      ])
        .then(([providerPayload, catalogResult]) => {
          if (!active) return;
          const providers = configuredModelProviders(providerPayload);
          const catalog = configuredModelCatalog(catalogResult.catalog);
          hasLoaded = true;
          setLoadError(null);
          setCatalogError(catalogResult.error);
          setReferenceData({ providers, catalog });
          setModelConfiguration((current) => modelConfigurationForCatalog(current, providers, catalog));
        })
        .catch((error) => {
          if (active && !hasLoaded) setLoadError(error);
        });
    refresh();
    const timer = setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  useEffect(() => {
    if (!referenceData || catalogRetryCount >= MODEL_CATALOG_RETRY_LIMIT) return undefined;
    const needsRetry = referenceData.providers.some(
      (provider) => !modelCatalogIsReady(referenceData.catalog, provider)
    );
    if (!needsRetry) return undefined;

    const timer = setTimeout(() => {
      api
        .modelCatalog()
        .then((payload) => {
          const catalog = configuredModelCatalog(payload);
          setReferenceData((current) => (current ? { ...current, catalog } : current));
          setModelConfiguration((current) => modelConfigurationForCatalog(current, referenceData.providers, catalog));
          setCatalogError(null);
        })
        .catch(setCatalogError)
        .finally(() => setCatalogRetryCount((count) => count + 1));
    }, MODEL_CATALOG_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [catalogRetryCount, referenceData]);

  useEffect(() => {
    if (!generationId) {
      setJob(null);
      setPollError(null);
      setPollPaused(false);
      return undefined;
    }

    let active = true;
    let timer = null;
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const next = await api.generation(generationId);
        if (!active) return;
        consecutiveFailures = 0;
        setJob(next);
        setPollError(null);
        setPollPaused(false);
        if (typeof next.request === 'string') setRequest((current) => current || next.request);
        setModelConfiguration((current) => ({
          ...current,
          ...(typeof next.model === 'string' ? { model: next.model } : {}),
          ...(typeof next.modelProvider === 'string' ? { model_provider: next.modelProvider } : {}),
          ...(typeof next.harness === 'string' ? { harness: next.harness } : {}),
          ...(typeof next.thinkingEffort === 'string' ? { thinking_effort: next.thinkingEffort } : {}),
        }));
        if (next.status === 'completed') {
          const editorPath = COPY[next.kind]?.editorPath || copy.editorPath;
          navigate(`${editorPath}?generation=${next.id}`, { replace: true });
          return;
        }
        if (next.status !== 'failed') timer = setTimeout(poll, GENERATION_POLL_MS);
      } catch (error) {
        if (!active) return;
        consecutiveFailures += 1;
        setPollError(error);
        if (generationPollShouldRetry(error, consecutiveFailures)) timer = setTimeout(poll, GENERATION_POLL_MS);
        else if (!generationPollErrorIsTerminal(error)) setPollPaused(true);
      }
    };
    poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [copy.editorPath, generationId, navigate, pollRevision]);

  if (!copy) return null;

  const fatalPollError = generationPollErrorIsTerminal(pollError);
  const generationRunning = generationIsRunning(generationId, job, pollError);
  const pollingStopped = fatalPollError || pollPaused;
  const configurationValid =
    !!referenceData && modelConfigurationIsValid(modelConfiguration, referenceData.providers, referenceData.catalog);
  const canGenerate = request.trim() && configurationValid && !submitting && !generationRunning;

  const startGeneration = async () => {
    if (!canGenerate) return;
    setSubmitting(true);
    setSubmitErrors([]);
    setPollError(null);
    setJob(null);
    try {
      const created = await api.createGeneration({
        kind,
        request: request.trim(),
        ...modelConfiguration,
      });
      setSearchParams({ job: created.id }, { replace: true });
    } catch (error) {
      setSubmitErrors(apiErrorMessages(error));
    } finally {
      setSubmitting(false);
    }
  };

  const resumePolling = () => {
    setPollPaused(false);
    setPollError(null);
    setPollRevision((revision) => revision + 1);
  };

  const errors = pollingStopped
    ? [
        pollPaused
          ? `${pollError?.message || 'The backend could not be reached.'} Status checks paused after ${GENERATION_POLL_FAILURE_LIMIT} attempts.`
          : pollError.message,
      ]
    : submitErrors;
  const blockedLabel = !request.trim()
    ? `Describe the ${copy.label}`
    : !referenceData?.providers.length
      ? 'Run ./kritt setup'
      : !configurationValid
        ? 'Choose a valid model configuration'
        : `Generate ${copy.label}`;
  const primaryEnabled = pollPaused || canGenerate;

  return (
    <div className="ai-generation-page" style={{ height: '100%', overflowY: 'auto', padding: '30px 32px 70px' }}>
      <div style={{ maxWidth: 920, margin: '0 auto' }}>
        <div style={{ fontSize: 25, fontWeight: 600 }}>{copy.title}</div>
        <div style={{ fontSize: 14, color: 'var(--text-2)', marginTop: 5, lineHeight: 1.5 }}>{copy.subtitle}</div>

        <section style={{ marginTop: 30 }}>
          <Label htmlFor={`generation-${kind}-request`}>DESCRIBE THE {copy.label.toUpperCase()}</Label>
          <textarea
            id={`generation-${kind}-request`}
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            disabled={generationRunning || submitting}
            maxLength={20_000}
            placeholder={copy.placeholder}
            style={{
              width: '100%',
              minHeight: 260,
              resize: 'vertical',
              padding: 16,
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--surface)',
              color: 'var(--text)',
              fontSize: 14,
              lineHeight: 1.65,
              outline: 'none',
            }}
          />
          <div
            className="ai-generation-guidance"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 18,
              fontSize: 12.5,
              color: 'var(--text-3)',
              marginTop: 8,
              lineHeight: 1.55,
            }}
          >
            <span>{copy.guidance}</span>
            <span className="mono" style={{ flex: 'none', fontSize: 10.5 }}>
              {request.length.toLocaleString()} / 20,000
            </span>
          </div>
        </section>

        <section style={{ marginTop: 28 }}>
          <Label>MODEL &amp; HARNESS</Label>
          {loadError ? (
            <GenerationError title="Could not load model options" errors={[loadError.message]} />
          ) : referenceData ? (
            <ModelConfiguration
              value={modelConfiguration}
              onChange={setModelConfiguration}
              providers={referenceData.providers}
              catalog={referenceData.catalog}
              catalogError={catalogError}
              disabled={generationRunning || submitting}
            />
          ) : (
            <Spinner label="Loading configured models…" />
          )}
        </section>

        {(generationRunning || job?.status === 'failed' || errors.length > 0) && (
          <section style={{ marginTop: 28 }}>
            {generationRunning && !pollingStopped ? (
              <GenerationProgress status={job?.status || 'pending'} kind={copy.label} />
            ) : job?.status === 'failed' ? (
              <GenerationFailure job={job} kind={copy.label} />
            ) : (
              <GenerationError
                title={pollPaused ? 'Status check paused' : 'Could not start generation'}
                errors={errors.length ? errors : [`The ${copy.label} could not be generated.`]}
              />
            )}
          </section>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginTop: 32,
            paddingTop: 18,
            borderTop: '1px solid var(--border)',
          }}
        >
          <Link
            to={copy.listPath}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--text-2)',
              fontSize: 13,
              cursor: 'pointer',
              padding: 0,
              textDecoration: 'none',
            }}
          >
            Back to {copy.plural.toLowerCase()}
          </Link>
          <button
            type="button"
            onClick={pollPaused ? resumePolling : startGeneration}
            disabled={!primaryEnabled}
            style={{
              height: 38,
              padding: '0 18px',
              border: 'none',
              borderRadius: 8,
              background: primaryEnabled ? 'var(--accent)' : 'var(--surface-2)',
              color: primaryEnabled ? 'var(--accent-fg)' : 'var(--text-3)',
              fontSize: 13.5,
              fontWeight: 500,
              cursor: primaryEnabled ? 'pointer' : 'default',
            }}
          >
            {pollPaused
              ? 'Check status again'
              : submitting
                ? 'Submitting…'
                : generationRunning
                  ? job?.status === 'running'
                    ? 'Generating…'
                    : 'Waiting for engine…'
                  : job?.status === 'failed'
                    ? 'Try again'
                    : blockedLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Label({ children, htmlFor }) {
  const style = { display: 'block', fontSize: 10, letterSpacing: 0, color: 'var(--text-3)', marginBottom: 9 };
  return htmlFor ? (
    <label htmlFor={htmlFor} className="mono" style={style}>
      {children}
    </label>
  ) : (
    <div className="mono" style={style}>
      {children}
    </div>
  );
}

function GenerationProgress({ status, kind }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--surface)',
        padding: '0 18px',
      }}
    >
      <Spinner label={status === 'running' ? `Generating and validating your ${kind}…` : 'Waiting for the engine…'} />
      <div style={{ fontSize: 12.5, color: 'var(--text-3)', margin: '-28px 0 18px 26px' }}>
        Invalid output is rejected before it reaches the editor.
      </div>
    </div>
  );
}

function GenerationFailure({ job, kind }) {
  const failure = generationFailureViewModel(job, kind);
  const runDetails = [
    { label: 'Reference', value: failure.reference },
    ...(failure.diagnosticCode ? [{ label: 'Diagnostic code', value: failure.diagnosticCode }] : []),
    ...(failure.submittedAt ? [{ label: 'Submitted', value: failure.submittedAt }] : []),
    ...(failure.startedAt ? [{ label: 'Started', value: failure.startedAt }] : []),
    ...(failure.completedAt ? [{ label: 'Finished', value: failure.completedAt }] : []),
    ...(failure.duration ? [{ label: 'Run time', value: failure.duration }] : []),
  ];
  const titleId = `generation-failure-title-${failure.generationId || 'current'}`;

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-labelledby={titleId}
      style={{
        border: '1px solid var(--border)',
        borderLeft: '3px solid var(--fail)',
        borderRadius: 8,
        background: 'var(--surface)',
        padding: 18,
        boxShadow: 'var(--shadow)',
      }}
    >
      <div className="generation-failure-header">
        <div style={{ minWidth: 0 }}>
          <div className="mono" style={{ color: 'var(--fail)', fontSize: 10, marginBottom: 5 }}>
            GENERATION FAILED
          </div>
          <div id={titleId} style={{ color: 'var(--text)', fontSize: 16, fontWeight: 600 }}>
            {failure.title}
          </div>
        </div>
        <span
          className="mono"
          style={{ color: 'var(--text-3)', fontSize: 10.5, overflowWrap: 'anywhere', textAlign: 'right' }}
        >
          {failure.reference}
        </span>
      </div>

      <div
        style={{
          marginTop: 16,
          padding: '11px 13px',
          borderRadius: 6,
          background: 'var(--fail-bg)',
          color: 'var(--text)',
          lineHeight: 1.55,
          overflowWrap: 'anywhere',
        }}
      >
        <div className="mono" style={{ color: 'var(--fail)', fontSize: 10, marginBottom: 4 }}>
          WHAT HAPPENED
        </div>
        {failure.message}
      </div>

      {failure.issues.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="mono" style={{ color: 'var(--text-3)', fontSize: 10, marginBottom: 8 }}>
            DRAFT VALIDATION ISSUES · {failure.issues.length}
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid var(--border)' }}>
            {failure.issues.map((issue, index) => (
              <li className="generation-validation-issue" key={`${issue.field}-${issue.message}-${index}`}>
                <span className="mono" style={{ color: 'var(--fail)', fontSize: 11, overflowWrap: 'anywhere' }}>
                  {issue.field}
                </span>
                <span style={{ color: 'var(--text-2)', lineHeight: 1.5, overflowWrap: 'anywhere' }}>
                  {issue.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        <div className="mono" style={{ color: 'var(--text-3)', fontSize: 10, marginBottom: 8 }}>
          RUN CONFIGURATION
        </div>
        <div className="generation-failure-context">
          {failure.configuration.map((item) => (
            <div key={item.label} style={{ minWidth: 0 }}>
              <div style={{ color: 'var(--text-3)', fontSize: 10.5, marginBottom: 3 }}>{item.label}</div>
              <div className="mono" style={{ color: 'var(--text)', fontSize: 11.5, overflowWrap: 'anywhere' }}>
                {item.value}
              </div>
            </div>
          ))}
        </div>
      </div>

      <details style={{ marginTop: 16, color: 'var(--text-2)', fontSize: 12 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 500 }}>Technical details</summary>
        <dl className="generation-failure-run-details">
          {runDetails.map((item) => (
            <div key={item.label} style={{ minWidth: 0 }}>
              <dt style={{ color: 'var(--text-3)', fontSize: 10.5 }}>{item.label}</dt>
              <dd className="mono" style={{ margin: '3px 0 0', overflowWrap: 'anywhere' }}>
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      </details>

      <div style={{ marginTop: 16, color: 'var(--text-3)', fontSize: 12, lineHeight: 1.5 }}>
        Your description is preserved above. Adjust it or the model configuration, then try again.
      </div>
    </div>
  );
}

function GenerationError({ errors, title = 'Generation failed' }) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        border: '1px solid var(--fail-bg)',
        borderRadius: 8,
        background: 'var(--fail-bg)',
        color: 'var(--fail)',
        padding: '14px 16px',
        fontSize: 12.5,
        lineHeight: 1.55,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {errors.map((error, index) => (
          <li key={`${error}-${index}`} style={{ color: 'var(--text-2)', overflowWrap: 'anywhere' }}>
            {error}
          </li>
        ))}
      </ul>
    </div>
  );
}
