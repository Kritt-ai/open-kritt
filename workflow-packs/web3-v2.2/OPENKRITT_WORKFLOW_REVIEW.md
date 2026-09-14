# OpenKritt Workflow Review and v2 Redesign

## Executive assessment

The original workflows already contain several strong research habits: production reachability, per-entrypoint flow tracing, concrete attacker control, falsification, and evidence-oriented reporting. The strongest existing design is the web evidence gate because it separates technical verification from program eligibility and deduplicates hypotheses before verification.

The pack still has five structural weaknesses that reduce bounty yield:

1. **Scope arrives too late or is missing.** Generic, Cosmos, authorization, and DeFi workflows do not freeze assets, accepted impacts, exclusions, known issues, and testing constraints before code analysis. Agents can spend most of the run on real bugs that cannot earn a bounty.
2. **A hypothesis is sometimes also the final judge.** The Cosmos panic-class steps investigate and immediately emit vulnerabilities. That violates the separate-verifier rule and raises false-positive risk.
3. **PoC is usually a plan, not evidence.** Several workflows return a reproduction plan but never require a tool-backed local test, fork, fuzzer, or deterministic proof before reporting.
4. **Deduplication and relative ranking are inconsistent.** Only the web workflow performs explicit root-cause consolidation. None of the specialized DeFi workflows compares surviving findings relative to each other.
5. **Target conclusions are hard-coded into reusable prompts.** The Pendle workflows assert that routers hold no funds, core math is exhausted and clean, or cross-chain paths are out of scope. Those statements may be true for one snapshot, but they become stale when the commit, deployment, program, or scope changes.

## Workflow-by-workflow findings

| Original workflow | Strong points | Main defects | v2 disposition |
|---|---|---|---|
| External Flow Analysis | Good entrypoint -> flow -> hypothesis -> verification chain | No scope/architecture contract, no dedup, no actual PoC, no ranking, single hypothesis run | Replaced by end-to-end evidence pipeline v2 |
| Cosmos ABCI Panic Halt | Strong ABCI enumeration and panic-class fan-out | Panic agents report directly; no independent verifier, PoC, dedup, program gate, consensus-wide effect proof | Rebuilt as consensus halt review v2 |
| Authorization & Business Logic | Good actor/resource/invariant model and hostile verification | No scope gate, dedup, PoC, ranking; one hypothesis lens mixes identity and workflow attacks | Rebuilt with two fresh-context hypothesis branches |
| Immunefi Web-App Evidence Gate | Best original workflow; good provenance, dedup, technical/program separation | Program scope is applied late; ENS-specific logic leaks into a general web workflow; PoC remains a plan; no relative ranking | Generalized and expanded as web evidence/program gate v2 |
| DeFi Permissionless Economic Abuse | Useful broad money-flow and arithmetic tracing | Overlaps with hardened v2, lacks dedup, PoC, program gate, ranking | Superseded by DeFi pipeline v3 |
| DeFi Economic Abuse v2 Hardened | Valuable fund provenance and refutation gates | Gates are Pendle-specific and sometimes classify instead of verify; "any gate fails" mishandles not-applicable gates; no scope/PoC/dedup/ranking | Generalized into evidence-based nine-gate verification |
| Pooled-TVL Theft | Correctly focuses on custody and conservation | Hard-coded contract list and old census; hard-coded 1% severity rule; assumes audited math is safe; no independent executable PoC step | Rebuilt to derive custody and thresholds from current evidence |
| Pendle Tokenomics Theft | Good tokenomics invariants and claim/replay coverage | Hard-coded exclusions and "already exhausted" claims; profit-only support can discard accepted freeze/governance impacts; no scope/PoC/dedup/ranking | Rebuilt as generic tokenomics value hunt v2 |

## Material design changes

### 1. Immutable scope contract at depth 0

Every workflow now begins by freezing:

- in-scope assets, contracts, chains, and components;
- accepted impacts and program-defined severity thresholds;
- exclusions, known issues, and testing restrictions;
- supplied deployment/runtime facts and explicit evidence gaps.

Later steps may use this contract but may not silently invent or refresh it from memory.

### 2. Architecture and attack surface before hypotheses

The general and web pipelines add a production architecture/trust-boundary pass before enumerating entrypoints. Specialized workflows use a domain-specific surface mapper with the same evidence standard.

### 3. Fresh-context dual hypothesis fan-out

Each flow or operation is analyzed independently by two agents with different lenses. The branches receive only the mapped flow/operation and immutable scope facts, not each other's hypotheses. This reduces fixation and adds repeatability without blindly running the same broad prompt.

### 4. Root-cause dedup before expensive verification

Hypotheses are merged by faulty operation, attacker primitive, broken invariant, terminal effect, and required fix. Endpoint, payload, victim, and CWE variations remain trigger variants of one root bug. This keeps strong-model verification focused on unique causes.

### 5. Independent hostile verification

The verifier receives a canonical hypothesis and is told to kill it. It must prove attacker control, production reachability, every guard, runtime state, and the terminal security effect. Verdicts are `supported`, `falsified`, or `blocked`; missing deployment facts cannot become positive evidence.

### 6. Deterministic PoC gate

A separate step now attempts the smallest decisive authorized local reproduction using tests, simulators, fuzzers, isolated services, or pinned blockchain forks. The result records exact commands, state before/after, observed effect, artifacts, and repeatability. A reproduction plan alone does not satisfy the gate.

### 7. Program eligibility after technical proof

Technical truth remains separate from bounty eligibility. Only a supported, production-reachable effect mapped to an exact in-scope asset and named accepted impact can become eligible. Program severity comes from the supplied rules, not hard-coded TVL percentages or platform memory.

### 8. Relative ranking before reporting

Surviving unique findings are compared by confidence, reachability, exploitability, demonstrated impact, scope fit, reproducibility, and evidence quality. The rank prioritizes researcher attention; it does not overwrite program severity.

## Recommended operating strategy

Use `01-bug-bounty-end-to-end-evidence-pipeline-v2.workflow.json` for unfamiliar repositories and broad programs. Use the web, authorization, Cosmos, DeFi, pooled-value, or tokenomics workflow when the accepted impacts and code domain justify the narrower search.

Do not run the old broad DeFi workflow and the hardened DeFi workflow together. The v3 DeFi pipeline replaces both. Run the pooled-value and tokenomics workflows after the general DeFi map when those asset classes are in scope; they are specialized searches, not independent claims that other surfaces are clean.

For cost control, use cheaper models for scope extraction, architecture, and surface mapping; a medium model for flow tracing and dual hypothesis generation; and the strongest model for canonical verification, PoC construction, eligibility, and final report review. The workflow prompts deliberately preserve evidence so model strength can increase without carrying unrelated investigation history.

## Required input quality

The v2 workflows expect current program text, deployment evidence, known issues, and testing constraints. If these are absent, the correct outcome is often `blocked`, not a fabricated confident finding. For smart contracts, provide chain, deployed address, and a fork block/snapshot whenever possible. For web targets, provide ingress/runtime configuration or a reproducible local deployment.

## Pack contents

- `01-bug-bounty-end-to-end-evidence-pipeline-v2.workflow.json`
- `02-cosmos-abci-consensus-halt-review-v2.workflow.json`
- `03-authorization-business-logic-abuse-v2.workflow.json`
- `04-web-application-evidence-program-gate-v2.workflow.json`
- `05-defi-permissionless-economic-exploit-pipeline-v3.workflow.json`
- `06-defi-pooled-value-conservation-hunt-v2.workflow.json`
- `07-tokenomics-value-theft-lock-hunt-v2.workflow.json`
- `_all_workflows_v2.json`
- `README.md`


## v2.1 import-valid correction

The initial v2 architecture was retained, but its serialization violated the engine's global output-key uniqueness and consume-all context rules. v2.1 introduced stage-specific output keys and one dedup boundary. The current portable v2.2 serialization additionally matches OpenKritt's official workflow-file contract:

- every intermediate depth has a unique semantic stage prefix (`scope_`, `surface_`, `hyp_`, `dedup_`, `verify_`, `poc_`, `program_`);
- workflow files use the `open-kritt-workflow` version 2 envelope;
- execution configuration and output schemas live at level scope, not inside steps;
- sibling hypothesis lenses share one `hyp_*` output schema, as required by the importer;
- the internal relative-ranking depth was removed because OpenKritt's built-in ranker already runs after dedup;
- the program gate reads the immutable program/deployment/known-issue snapshots directly from `extra` after the dedup context boundary;
- `file_path` and `line` are reserved for the final finding schema;
- bare testing constraints now reference `extra.authorized_test_constraints`;
- mapping prompts require deterministic ripgrep/AST/compiler enumeration and two passes by default;
- PoC construction runs only for `dedup_triage_priority=high` candidates;
- `fork_rpc_url`, `fork_block`, and `repeat_runs` are explicit workflow extras.

All seven workflows pass `frontend/src/lib/workflowTransfer.js` parsing and
`backend/src/lib/validation.js` validation from this OpenKritt checkout. The checks
cover output-key uniqueness, reference availability across the consume-all boundary,
derived extras, sibling schemas, one dedup consume-all depth, sequential depths, and
the terminal finding contract.


## v2.2 Web3 expansion

The DeFi, pooled-value, and tokenomics workflows now map transparent/UUPS/beacon/diamond/clone/delegatecall deployment paths, initializer and upgrade authorization, selector routing, and storage layout across evidenced versions. Their second hypothesis lens explicitly covers takeover, initialization replay, storage collision, selector clash, delegatecall target control, and proxy/implementation authorization disagreement.

Each mapped operation also carries a two-hop local cross-contract neighborhood with related public operations and shared state. This lets the existing per-operation composition agent construct multi-contract exploit sequences without adding a second `consumeAll` boundary. Engine-level fresh-context repetition remains a scan configuration choice and is documented separately from the mapping agent's internal deterministic passes.
