# Somnia 2025 workflow-recall benchmark

This benchmark measures whether an OpenKritt workflow can independently recover
three disclosed Somnia findings from the vulnerable source snapshot. The known
findings are grading data. They must never be included in the scan target,
workflow prompts, scan extras, repository dependencies, or model context.

## Snapshot gate

Do not run or score the benchmark until `snapshot.json` has all of these fields:

- `verification_status` is `verified`.
- `resolved_commit` is a full 40-character Git object ID.
- `tree_sha256` is the SHA-256 digest of a deterministic source-tree archive.
- `source_provenance` explains where the Git object was recovered.
- `contains_expected_vulnerable_code` is `true`, based on a post-run comparison
  performed only after the blind scan has finished.

The public reports do not identify one common revision. Other reports from the
same contest reference `ea5c191a893153fe020aac35532bbcaca0f8c5d1`, so it is a
candidate only. It must not be treated as the benchmark revision without the
Git object and vulnerable tree.

## Blind run protocol

1. Copy the verified detached worktree under OpenKritt's `LOCAL_REPOS_PATH`.
2. Start a fresh scan with the current unmodified general bug-bounty workflow.
3. Supply only `blind-inputs.json` and the source tree. Do not expose
   `ground-truth.json`, report titles, report URLs, author names, PoCs, or source
   snippets from the reports to the scan.
4. Pin the model, harness, thinking effort, workflow export hash, post-script
   hash, configuration, job limit, and engine commit in `runs/<run-id>.json`.
5. Use engine-level `configuration.repeat_runs`; prompt text such as
   `extra.repeat_runs` is metadata and does not create independent executions.
6. Export every terminal result, including empty, failed, stopped, blocked, and
   stubbed branches. A model/provider failure is an infrastructure failure, not
   a zero-recall result.
7. After the scan is terminal, grade it against `ground-truth.json` and record
   where each root cause was first present, lost, falsified, or blocked.

## Score

Primary score is root-cause recall out of three. A hit requires the faulty
operation, attacker-controlled primitive, broken invariant, and terminal effect.
Generic advice such as "validate state transitions" or "check deserialization
bounds" is not a hit.

Secondary diagnostics:

- discovery recall: the root cause appeared in any intermediate hypothesis;
- final recall: the root cause survived to an emitted finding;
- localization: the faulty operation/file was identified;
- exploit trace: an ordered attacker-input-to-impact path was produced;
- evidence status: supported, falsified, blocked, stubbed, or infrastructure-failed;
- attrition stage: mapping, hypothesis, consume-all dedup, verification, or final gate;
- false positives: distinct unsupported final root causes;
- cost: model jobs and elapsed time.

Run the baseline before editing workflows. Workflow changes are evaluated on a
new run with the same snapshot and run controls. Never tune on one report and
claim general improvement: report per-finding results and the three-finding
macro score.
