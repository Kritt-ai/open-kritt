# OpenKritt Web3 Bug-Bounty Workflow Pack v2.2

This directory contains seven portable OpenKritt workflow files for authorized Web3,
smart-contract, DeFi, tokenomics, and Cosmos bug-bounty research. Each
`*.workflow.json` file uses the current `open-kritt-workflow` version 2 import format
and has been parsed and validated against this repository's current frontend importer
and backend workflow validator.

## Import

Import one workflow at a time from the OpenKritt UI, or use the headless CLI:

```bash
./kritt-headless import workflow \
  ./workflow-packs/web3-v2.2/05-defi-permissionless-economic-exploit-pipeline-v3.workflow.json
```

`_all_workflows_v2.json` is a review/distribution bundle containing all seven portable
documents. OpenKritt's importer accepts one workflow document per invocation, so do
not import the bundle directly.

## Choosing a workflow

| File | Use it for |
|---|---|
| `01-bug-bounty-end-to-end-evidence-pipeline-v2.workflow.json` | Broad or unfamiliar bounty targets |
| `02-cosmos-abci-consensus-halt-review-v2.workflow.json` | Cosmos SDK / CometBFT chain-halt and consensus paths |
| `03-authorization-business-logic-abuse-v2.workflow.json` | Authorization, ownership, replay, signatures, and state-machine abuse |
| `04-web-application-evidence-program-gate-v2.workflow.json` | In-scope web/API surfaces with a bounty-program evidence gate |
| `05-defi-permissionless-economic-exploit-pipeline-v3.workflow.json` | Default broad DeFi and smart-contract hunt |
| `06-defi-pooled-value-conservation-hunt-v2.workflow.json` | AMMs, vaults, lending pools, bridges, and pooled-value conservation |
| `07-tokenomics-value-theft-lock-hunt-v2.workflow.json` | Staking, gauges, voting escrow, emissions, vesting, and claims |

For a typical DeFi target, start with workflow 05 and use 06 or 07 as a focused
follow-up when the accepted impacts and custody model justify it.

## Required scan extras

The prompts derive these values from `extra.*` references: current program rules,
deployment evidence, known issues, authorized testing constraints, fork RPC URL,
pinned fork block, and mapping-pass count. Missing decisive evidence should result in
`blocked`, not an assumed finding.

See `OPENKRITT_WEB3_RUN_PROFILE.md` for model/cost guidance and
`OPENKRITT_WEB3_BUILTIN_RANKER.md` for the ranker policy.
