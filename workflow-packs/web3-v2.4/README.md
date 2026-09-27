# OpenKritt Web3 Bug-Bounty Workflow Pack v2.4

This directory contains seven portable OpenKritt workflows for authorized Web3,
smart-contract, DeFi, tokenomics, and Cosmos bug-bounty research. Each
`*.workflow.json` file uses the `open-kritt-workflow` version 2 import format and
is validated against this checkout's frontend importer and backend validator.

Version 2.4 balances breadth and progress:

- mapping and every sibling hypothesis branch finish before verification begins;
- one `consumesAll` step consolidates duplicate root causes before expensive jobs;
- consolidation keeps every distinct code-grounded candidate, regardless of triage
  priority;
- canonical candidates fan out independently through verification, safe reproduction,
  program eligibility, and final emission;
- OpenKritt post-processing performs the final finding-level deduplication and ranking.

This fixes the v2.3 depth-first failure mode. In v2.3, the first hypothesis could start
an expensive verification job before the remaining hypothesis branches ran. A provider
block or runner failure in that job could fail the scan with most coverage never
attempted.

## Import

Import one workflow at a time from the OpenKritt UI, or use the headless CLI:

```bash
./kritt-headless import workflow \
  ./workflow-packs/web3-v2.4/05-defi-permissionless-economic-exploit-pipeline-v3.workflow.json
```

`_all_workflows_v2.json` is a review/distribution bundle containing all seven
portable documents. The importer accepts one workflow document per invocation, so do
not import the bundle directly.

## Choosing a workflow

| File                                                                | Use it for                                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `01-bug-bounty-end-to-end-evidence-pipeline-v2.workflow.json`       | Broad or unfamiliar bounty targets                                    |
| `02-cosmos-abci-consensus-halt-review-v2.workflow.json`             | Cosmos SDK / CometBFT chain-halt and consensus paths                  |
| `03-authorization-business-logic-abuse-v2.workflow.json`            | Authorization, ownership, replay, signatures, and state-machine abuse |
| `04-web-application-evidence-program-gate-v2.workflow.json`         | In-scope web/API surfaces with a bounty-program evidence gate         |
| `05-defi-permissionless-economic-exploit-pipeline-v3.workflow.json` | Default broad DeFi and smart-contract hunt                            |
| `06-defi-pooled-value-conservation-hunt-v2.workflow.json`           | AMMs, vaults, lending pools, bridges, and pooled-value conservation   |
| `07-tokenomics-value-theft-lock-hunt-v2.workflow.json`              | Staking, gauges, voting escrow, emissions, vesting, and claims        |

For a typical DeFi target, start with workflow 05 and use 06 or 07 as a focused
follow-up when the accepted impacts and custody model justify it.

## Required scan extras

The prompts derive current program rules, deployment evidence, known issues,
authorized testing constraints, fork RPC URL, pinned fork block, and mapping-pass
count from `extra.*`. Missing decisive evidence should result in `blocked`, not an
assumed finding.

## Provider and resource requirements

The coverage barrier fixes workflow ordering; it cannot bypass provider policy.
Verification and PoC prompts require a provider/account that permits authorized
security research. Configure a depth override for the verification depth when the
default provider returns `cyber_safety_blocked`.

Run one broad workflow at a time with conservative engine concurrency. A deduplicated
pack reduces expensive jobs, but repository-backed verification can still exceed a
small per-runner memory cap.

See `OPENKRITT_WEB3_RUN_PROFILE.md` for model/concurrency guidance and
`OPENKRITT_WEB3_BUILTIN_RANKER.md` for the ranker policy.
