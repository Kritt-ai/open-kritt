<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.png" />
  <img alt="open·kritt" src="docs/images/logo-light.png" width="96" height="96" />
</picture>

# open·kritt

**Orchestrate AI agents to find real vulnerabilities in code.**

An open-source, self-hosted security research platform that turns focused AI analysis
into de-duplicated, ranked, and reviewable findings.

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Kritt-ai/open-kritt?sort=semver)](https://github.com/Kritt-ai/open-kritt/releases)
[![Documentation](https://img.shields.io/badge/docs-docs.kritt.ai-ff5c3d.svg)](https://docs.kritt.ai/)

[Documentation](https://docs.kritt.ai/) ·
[Installation](https://docs.kritt.ai/getting-started/installation-and-setup) ·
[First scan](https://docs.kritt.ai/first-scan/workflow) ·
[Contributing](CONTRIBUTING.md)

</div>
![open·kritt workflow builder](assets/workflow_screen.png)

## Why open·kritt?

Pointing a model at an entire repository and asking it to find vulnerabilities rarely
works well. open·kritt breaks a security review into small, structured tasks, fans those
tasks out across AI agents, and brings the results back into one place for validation and
prioritization.

You keep control of the prompts, target scope, model provider, execution settings, and
infrastructure. open·kritt supplies the orchestration: reusable workflows, structured
findings, automatic de-duplication, severity ranking, post-processing, logs, and re-runs.

### Key capabilities

- **Reusable workflows** — compose focused prompts into multi-stage research playbooks,
  including fan-out, sibling steps, batching, and per-scan variables. [Learn about workflows](https://docs.kritt.ai/workflows/steps).
- **Flexible targets** — scan remote Git repositories, mounted local repositories, and
  dependency-expanded workspaces. [Configure a scan](https://docs.kritt.ai/scans/create).
- **Provider choice** — run through Codex, Claude Code, or OpenRouter with the model and
  reasoning settings selected per scan. [Configure AI access](https://docs.kritt.ai/ai-provider-setup/overview).
- **Finding enrichment** — validate findings, generate reports or PoCs, and attach compact
  result chips with one or more post-scripts. [Use post-scripts](https://docs.kritt.ai/post-scripts/recommended-usage).
- **Program-specific ranking** — combine severity rules that match the scope and impact
  language of the program you are reviewing. [Create severity rankers](https://docs.kritt.ai/severity-ranker/why).
- **Inspectable execution** — follow active logs, review failures, resume interrupted
  scans, and keep completed work across re-runs. [Review errors and re-runs](https://docs.kritt.ai/scan-results/errors-and-re-runs).

> **Built from real security research.** The Kritt team has earned over **$1,500,000 in
> bug-bounty payouts** under the researcher name **Blockian**
> ([Immunefi](https://immunefi.com/profile/Blockian/) ·
> [HackenProof](https://hackenproof.com/hackers/Blockian) ·
> [blockian.xyz](https://blockian.xyz) · [@ControlZ_1337](https://x.com/ControlZ_1337)).

## How a scan works

```mermaid
flowchart LR
    A[Repository and scan configuration] --> B[Workflow steps]
    B --> C[Candidate findings]
    C --> D[De-duplicate and rank]
    D --> E[Post-scripts]
    E --> F[Reviewable results]
```

Workflow steps run in depth order and can fan out across targets or analysis categories.
The engine combines duplicate findings, applies the selected severity rankers, and runs
post-scripts against each canonical finding. The UI keeps the supporting explanation,
source location, trigger flow, malicious actor and input, ranking, enrichment, and scan
logs together for review.

## Quick start

You need [Git](https://git-scm.com/), Docker with Docker Compose, and Node.js 20 or newer.
The repository-local CLI has no install step.

```bash
git clone https://github.com/Kritt-ai/open-kritt.git
cd open-kritt
./kritt setup
./kritt start
```

Open [http://localhost:5173](http://localhost:5173) after the stack starts. Setup guides
you through one supported model-access option; a `GITHUB_TOKEN` is optional and only
needed for private GitHub repositories or dependencies.

Continue with the [installation guide](https://docs.kritt.ai/getting-started/installation-and-setup)
for platform notes and manual Docker setup, then follow the
[first-scan tutorial](https://docs.kritt.ai/first-scan/workflow).

## Security model

open·kritt intentionally gives scan agents powerful analysis environments. Tool-enabled
agents run as root inside disposable job containers, receive writable copies of target
repositories, and have direct internet access. The engine controls Docker to create those
jobs.

The default services bind to `127.0.0.1`, and the backend does not provide application
authentication. Keep the stack private, use a dedicated Docker host or VM for untrusted
targets, scope provider and GitHub credentials minimally, and understand that repository
content is sent to the model provider you configure.

Read the full [threat model](docs/threat-model.md) before scanning untrusted or sensitive
code. Report vulnerabilities in open·kritt privately according to [SECURITY.md](SECURITY.md).

## Documentation

The complete documentation is published at **[docs.kritt.ai](https://docs.kritt.ai/)**.

| I want to… | Guide |
| --- | --- |
| Install and launch open·kritt | [Installation and setup](https://docs.kritt.ai/getting-started/installation-and-setup) |
| Configure model access | [AI provider setup](https://docs.kritt.ai/ai-provider-setup/overview) |
| Run an end-to-end first scan | [Your first workflow](https://docs.kritt.ai/first-scan/workflow) |
| Understand workflow execution | [Steps](https://docs.kritt.ai/workflows/steps), [depth and siblings](https://docs.kritt.ai/workflows/depth-and-siblings), and [batches](https://docs.kritt.ai/workflows/batches) |
| Configure scan inputs and models | [Scan configuration](https://docs.kritt.ai/scans/configuration) and [model and harness](https://docs.kritt.ai/scans/model-and-harness) |
| Validate, report, or build PoCs | [Recommended post-script usage](https://docs.kritt.ai/post-scripts/recommended-usage) |
| Review findings and failures | [Viewing results](https://docs.kritt.ai/scan-results/how-to-view) and [errors and re-runs](https://docs.kritt.ai/scan-results/errors-and-re-runs) |
| Tune engine runtime controls | [Settings](https://docs.kritt.ai/getting-started/settings) |
| Compare deployment options | [Self-hosted vs managed](https://docs.kritt.ai/getting-started/self-hosted-vs-managed) |

The deployed site is built from [`docs-site/`](docs-site/). See its
[contributor notes](docs-site/README.md) to preview or edit the documentation locally.

## Project layout

open·kritt is a polyglot monorepo whose services ship as one version:

| Path | Purpose | Stack |
| --- | --- | --- |
| [`frontend/`](frontend/) | Web UI | React + Vite |
| [`backend/`](backend/) | HTTP API and persistence layer | Node + Express + Prisma |
| [`engine/`](engine/) | Scan orchestration and AI harness execution | Python |
| [`database/`](database/) | PostgreSQL image and forward-only migrations | PostgreSQL |
| [`executor-view/`](executor-view/) | Live executor and engine-log viewer | Python |
| [`scripts/`](scripts/) | Repository tooling and CLI implementation | Node |
| [`docs-site/`](docs-site/) | Source for [docs.kritt.ai](https://docs.kritt.ai/) | Mintlify MDX |

For development setup, component test commands, database migration rules, and the pull
request process, read [CONTRIBUTING.md](CONTRIBUTING.md).

## Community

- Ask questions and share ideas in [GitHub Discussions](https://github.com/Kritt-ai/open-kritt/discussions).
- Report bugs and request features through [GitHub Issues](https://github.com/Kritt-ai/open-kritt/issues).
- Propose changes by following the signed-off, Conventional Commit workflow in
  [CONTRIBUTING.md](CONTRIBUTING.md).
- Report security issues privately through the process in [SECURITY.md](SECURITY.md), not
  through a public issue.

## License

open·kritt is licensed under the [GNU Affero General Public License v3.0](LICENSE).
