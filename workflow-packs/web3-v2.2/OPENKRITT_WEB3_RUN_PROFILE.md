# OpenKritt Web3 Run Profile

Use the DeFi v3 workflow as the default broad smart-contract hunt. Use pooled-value and tokenomics as focused follow-ups, and Cosmos only for Cosmos/CometBFT targets. The web workflow is secondary and should run only when a web/API asset is in scope or can produce an accepted on-chain impact.

## Model layering

| Stage | Recommended tier | Purpose |
|---|---|---|
| Scope and architecture/surface mapping | Lower-cost repository-capable model | Deterministic enumeration, classification, wiring, and evidence capture |
| Flow tracing and hypothesis fan-out | Medium/strong model | State transitions, invariants, attacker sequences, and cross-contract composition |
| Dedup | Medium model | Root-cause clustering before expensive work |
| Verification, PoC, program gate, final report | Strongest model available (for example Opus 4.8 or GPT-5.6 high reasoning) | Adversarial falsification, arithmetic, fork tests, and evidence review |

## Repeatability

- Set `repeat_runs=2` for surface mapping.
- The two hypothesis branches are already independent runs with different lenses.
- Repeat decisive PoCs at least twice when practical.
- Merge repeated candidates by the dedup fingerprint and preserve unique findings for verification.

## Cost gates

- Build/run a PoC only for `dedup_triage_priority=high`.
- A lower-priority candidate can be promoted after manual review or stronger runtime evidence.
- Supply `fork_rpc_url` and `fork_block` for deployed contract investigations.


## Engine-level repeat runs

The workflow `extra.repeat_runs` asks one mapping agent to perform multiple deterministic enumeration passes inside the same context. It improves tool coverage but is not an independent model run. For high-value targets, also set the scan engine's `configuration.repeat_runs=2` so the task is rerun with fresh context and merged before dedup. This doubles the relevant scan cost; use it for final high-value coverage or benchmarking rather than every exploratory run.

## Cross-contract composition in v2.2

The three Web3 workflows carry a two-hop local neighborhood with every mapped operation: callers/callees, callbacks, related public operations, proxy path, and shared state. The composition lens can therefore build multi-contract chains without a second global `consumeAll`. A future global graph-composition pass may still find longer chains, but it should be added only with an engine-supported context artifact rather than another collapsing aggregation depth.
