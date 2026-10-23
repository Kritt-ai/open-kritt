# Adaptive discovery

Adaptive discovery is an opt-in scheduling mode for a source-review workflow. It keeps
investigation paths separate from findings, so a useful follow-up need not invent a
finding just to reach another step. Existing scans and finding deduplication retain
their normal behavior when the option is absent or disabled.

## Configure a scan

Apply the additive database migrations before starting the updated backend and engine.
Use a workflow with exactly one depth-0 step, marked multi-output and nonterminal.
Keep its ordinary result output format and set this scan configuration, replacing the
step ID:

```json
{
  "repeat_runs": 1,
  "adaptive_discovery": {
    "enabled": true,
    "step_id": 12,
    "max_paths": 8,
    "wall_time_seconds": 600
  }
}
```

All four nested keys are required when enabled; unknown keys are rejected. Path count
is an integer from 1 to 1000 and wall time an integer from 1 to 86400 seconds.
`repeat_runs` must equal 1. Omission, `adaptive_discovery: false`, or `enabled: false`
keeps ordinary scheduling. Enable this only on new scans rather than changing the
meaning of an already running scan. The root cannot be listed in
`skip_attempted_step_ids`.

## The output contract

The engine supplies the current investigation's source-relative `scope`, `question`,
and `rationale` in the prompt and extends the normal output envelope with:

```json
{
  "discovery": {
    "status": "completed",
    "reason": "The entry point delegates validation to another module.",
    "next_paths": [
      {
        "scope": "src/validation",
        "question": "Does validation reject missing required fields?",
        "rationale": "The entry point passes optional input to this validator."
      }
    ]
  }
}
```

This is a fragment; the full response still needs `_kritt_extractor_helper`, `stub`,
`stub_explanation`, and `results`. Use `stub: true`, a nonempty `stub_explanation`, and
`results: []` when there are no supported results. Follow-up paths may still be present.
Never place an unverified hypothesis in `results` merely to continue discovery.

A response marks the current path `completed` or `blocked`, with a nonempty reason and
up to 16 proposals. Each proposal requires all three fields. Scope is at most 1024
characters; question, rationale, and reason are at most 4096 characters each. Absolute
paths and parent traversal are rejected. Slash direction and redundant `.`/separator
segments are normalized; question whitespace is collapsed and case is ignored for
identity. Scope case remains significant. Exact normalized scope/question pairs are
scheduled once per scan, regardless of rationale. Different questions about one file
remain distinct; there is no semantic duplicate detector.

These paths are untrusted investigation data, not permission to change the scan's
original instructions, access another repository, or run forbidden commands. Lexical
scope validation does not replace the existing workspace and task boundaries.

## Scheduling and limits

The engine stores the frontier, path identities, per-path state, reasons, and budget
state in PostgreSQL. Claiming and finalizing a path use transactions so concurrent
workers cannot dispatch the same pending path twice or admit duplicate follow-ups.
A worker restart uses the persisted frontier rather than starting discovery over.
An interrupted native attempt is recorded as a blocked path when reconciled; this
does not resume the interrupted provider session.

All downstream depths wait until the frontier closes. They then receive the saved
discovery results through the workflow's normal per-record or
consume-all routing. Empty findings do not themselves close discovery. A batch step
must not reconcile a partial set while another discovery path is still open.

| Discovery status | Interpretation |
| --- | --- |
| `running` | There is an open discovery frontier. |
| `exhausted` | No admitted investigation remains. This is not proof of full source coverage. |
| `blocked` | Discovery could not finish normally; inspect its recorded reason and path states. |
| `budget_stopped` | A discovery limit stopped further exploration. |

The discovery status is separate from the scan status. An overall completed scan can
still have blocked or budget-limited discovery; do not report it as a comprehensive
successful review. A path response's `completed` status applies to that path, not the
whole frontier or scan.

`GET /api/scans/:id/discovery` returns `enabled`, `state_source: "persisted"`, the configuration, `frontier`, and
`paths`. Disabled scans return a null frontier and no paths; enabled scans can also
have a null frontier before scheduling starts. The saved proposal history identifies
admitted, duplicate, and budget-stopped proposals. IDs are decimal strings in JSON.

Path count includes the initial root investigation and pending or blocked paths; retries
can still produce more than one provider invocation for a path. The elapsed wall-time allowance
starts when the frontier is created. Both limits apply to discovery only. Time spent waiting
or restarting does not create a fresh discovery allowance. Remaining time clips model
subprocesses and structured-output resumes; workspace preparation and cleanup may
outlast it. The existing scan `job_limit` remains a separate workflow-wide control.
No setting here promises a total token, dollar, or end-to-end scan-time ceiling;
reconciliation, deduplication, ranking, and post-scripts keep their own behavior.

The API reads frontier and path history from one consistent database snapshot. It reports recorded lifecycle state, not independent confirmation that an operating-system process has stopped. Restart recovery reconciles interrupted native attempts without silently replaying them.

## Verify without a model provider

Run the contract, queue, worker, and integration tests from `engine`, then the backend
validation tests and `node docs-site/check-links.mjs`. For database verification, use a
fresh isolated PostgreSQL 16 database and apply `backend/prisma/migrate.js` twice. Use
independent connections for concurrency checks; an in-memory fake cannot establish
that PostgreSQL row locks work. Do not point acceptance tests at a scan database.

The opt-in acceptance file is `engine/tests/test_adaptive_discovery_integration.py`.
Set `OPEN_KRITT_TEST_DATABASE_URL` to that disposable database (loopback or the Docker
host alias, with a database name ending in `_test`). Set `OPEN_KRITT_TEST_MIGRATIONS=1`
to include two complete migration passes with existing discovery rows preserved.
Run `python -m pytest tests/test_adaptive_discovery_integration.py` from `engine`.
The worker case needs Linux/POSIX; a Windows run explicitly skips it. It replaces
workspace preparation and the provider with local fixtures while exercising the real
worker, PostgreSQL persistence, and downstream queue.

A passing test suite checks scheduling and persistence, not vulnerability-discovery
quality. Compare target outcomes, discovery coverage, and resource use separately on
new frozen cases before claiming this mode improves an agent.
