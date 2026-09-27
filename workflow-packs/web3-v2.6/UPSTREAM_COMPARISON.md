# Workflow Recall Review: upstream vs downstream v2.4

## Finding

The downstream v2.4 pack optimizes precision before OpenKritt has persisted a
candidate. Upstream's proven workflows optimize branch-local attention and emit a
finding immediately after focused investigation. The added v2.4 gates therefore
compound false negatives, especially when source dependencies, provider access, or
runtime budget are imperfect.

## Structural comparison

| Design | Levels | Steps | Consume-all | Approx. schema fields | Finding emission |
| --- | ---: | ---: | ---: | ---: | --- |
| Upstream `external-flow-analysis` | 3 | 3 | 0 | 24 | Per flow at depth 2 |
| Upstream `Cosmos ABCI Panic Halt Review` | 2 | 5 | 0 | 20 | Per ABCI method at depth 1 |
| Downstream broad v2.4 | 8 | 9 | 1 | 119 | After dedup, verification, reproduction, and program gate |
| Downstream focused v2.4 workflows | 6-8 | 7-9 | 1 | 104-134 | After the same precision pipeline |
| Recall-first v2.6 | 3 | 3 | 0 | 24 | Per flow at depth 2; configuration matches upstream |

The schema-field count is a proxy for how much structured context each branch must
carry, not a quality score. The important difference is that upstream and v2.6 do not
place a global aggregation prompt between flow discovery and finding emission.

## Evidence from local scans

The recent completed v2.4 scans show severe branch attrition before a finding row was
created:

| Scan | Workflow family | Attempts | Empty step results | Result |
| ---: | --- | ---: | ---: | --- |
| 7 | DeFi balanced v2.4 | 15 | 10 (67%) | No raw candidates |
| 12 | Pooled-value v2.4 | 14 | 12 (86%) | No raw candidates |
| 13 | Tokenomics v2.4 | 11 | 5 (45%) | Consume-all returned an empty aggregate; no findings |
| 4 | DeFi progressive v2.3 | 21 | 18 (86%) | No findings |

Scan 8 completed only 101 of 230 expected lineages before a provider authentication
failure. Several branches also reached source declared through `go.mod` replacements
that was absent from the workspace and returned empty stubs. This run cannot support a
"no bugs" conclusion because discovery coverage and source completeness both failed.

## Root causes

1. **Precision gates run too early.** A real technical bug can be discarded by the
   hypothesis prompt, global dedup prompt, verifier, reproduction requirement, and
   program gate in sequence.
2. **Global aggregation is a recall bottleneck.** One consume-all response must retain
   every distinct candidate from a large context. In scan 13 it retained none.
3. **Program language biases discovery.** Excluding issue classes before technical
   analysis can hide paid bugs whose accepted impact differs from their generic label,
   such as externally induced node or consensus failures.
4. **Missing source looks like a clean branch.** Agents returned stubs when referenced
   dependency code was unavailable. Source completeness must be a run precondition.
5. **Configured repetition was illusory.** Current scans put `repeat_runs` under prompt
   extras rather than the engine configuration, so the engine did not repeat discovery.
6. **Provider failure invalidates coverage.** A mid-workflow model override failed
   before more than half the expected lineages completed.

## v2.6 decision

The first correction is one benchmarkable recall workflow, not another seven-workflow
rewrite. v2.6 exactly preserves upstream's depths, step count, fan-out flags,
consume-all flags, and output schemas. It changes only the three prompt methods. The
single final investigation applies a fixed matrix covering protocol-state bypasses,
parser/crash boundaries, and accounting/consensus invariants, then emits concrete
technical candidates before deduplication, PoC, severity, or program eligibility.
Those later stages can reject or rank a stored candidate without erasing evidence that
discovery found it.

After a known historical code snapshot is available, compare upstream, v2.4, and v2.6
blindly with identical model, source tree, configuration, and repetition count. Measure
ground-truth recall first, then false-positive rate and cost.
