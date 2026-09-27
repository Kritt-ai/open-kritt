# OpenKritt Web3 Run Profile v2.4

Use the DeFi v3 workflow as the default broad smart-contract hunt. Use pooled-value
and tokenomics as focused follow-ups, and Cosmos only for Cosmos/CometBFT targets.

## Model layering

| Stage                                  | Recommended tier                            | Purpose                                                          |
| -------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| Scope and architecture/surface mapping | Lower-cost repository-capable model         | Deterministic enumeration, wiring, and evidence capture          |
| Flow tracing and hypothesis fan-out    | Medium/strong repository-capable model      | Invariants, attacker sequences, and cross-contract composition   |
| Root-cause consolidation               | Strong model with sufficient context window | Preserve coverage while merging only genuinely duplicate causes |
| Verification + PoC                     | Strongest authorized security model         | Adversarial falsification and safe local/fork tests              |
| Program gate + final finding           | Strong model                                | Exact scope mapping and honest confidence labeling               |

For the compact DeFi, pooled-value, tokenomics, authorization, and Cosmos workflows,
verification is depth 4. For the broad and web workflows it is depth 6. Use a model
override at that depth if the default provider blocks authorized security analysis.

## Execution profile

- Run one broad scan at a time until resource use is characterized.
- Start with two engine workers and at most two workers per scan on a 16 GiB host.
- Keep at least 2 GiB reserved for the engine/host.
- Use a per-runner cap above 1.5 GiB only after checking Docker events and engine logs;
  exit 137 alone does not prove memory exhaustion.
- Do not spend cyber-safety retries on an account that consistently blocks the task.
  Change to an authorized provider/account instead.

## Coverage and repeatability

- The v2.4 consolidation barrier waits for all sibling hypothesis branches.
- Consolidation emits every distinct code-grounded root cause. Priority is advisory
  and must not suppress medium- or low-priority candidates.
- Set the workflow extra `repeat_runs=2` for deterministic mapping passes.
- Use the engine's `configuration.repeat_runs=2` only for high-value benchmarking;
  it reruns applicable jobs with fresh context and increases cost.
- Repeat decisive PoCs at least twice when practical.
- Let final post-processing merge findings by root-bug fingerprint and rank canonical
  results.

## Evidence gates

- Attempt a safe local PoC for every technically supported candidate.
- A supported candidate blocked only by a specific runtime fact remains visible with
  `exploitable=false` and `report_confidence=needs_manual_validation`.
- Supply `fork_rpc_url` and `fork_block` for deployed contract investigations.
- Never send transactions to a public network.
