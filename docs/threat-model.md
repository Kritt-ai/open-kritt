# Threat model & security design

open·kritt runs AI agents over **potentially untrusted source code** and handles
**model/provider credentials** and repository tokens. This document describes the trust
boundaries, what data goes where, and how to deploy it safely. It complements the
disclosure process in [SECURITY.md](../SECURITY.md).

> **One-line summary:** scan agents run as root in disposable containers with writable
> workspaces and direct internet access. Treat repositories and model output as untrusted,
> isolate the Docker host, scope credentials minimally, and keep the API private.

## Components & data flow

| Component | Role | Trust level |
| --- | --- | --- |
| `frontend` | UI (React/Vite) | operator-facing |
| `backend` | REST API + Postgres access (Express/Prisma) | operator-facing, **unauthenticated by default** |
| `database` | Postgres — workflows, scans, findings | trusted store |
| `engine` | Claims scans, checks out repos, runs harnesses | **analyzes untrusted code & prompts** |
| `executor-view` | Read-only view of executor state/accounts | operator-facing |

Flow: UI → backend (create workflow/scan) → Postgres queue → **engine** checks out the
target repo (+ dependency repos), builds a workspace, and runs each workflow step through
an AI **harness** (`codex` / `claude-code` / `grok-build`), which sends repository
content to the **configured model/provider endpoint** → results are written back to
Postgres → UI.

Workflow and post-script generation uses a separate Postgres queue. The natural-language
request is sent to the selected provider, but the generation harness runs without model
tools or repository access. Postgres retains the request and stores only a validated
draft or safe failure details, not invalid raw model output; the backend validates
completed drafts again before the UI may review them.

## Trust boundaries

1. **Operator ↔ backend/UI.** The API and UI are unauthenticated by default. Anyone who
   can reach them can read/create scans, read findings, and change provider account
   configuration. **Boundary you must enforce yourself** (network isolation / a reverse
   proxy with auth).
2. **Engine ↔ analyzed code.** The engine checks out arbitrary repositories and runs AI
   agents against them. Tool-enabled jobs run as root inside disposable nested containers,
   with a writable per-job checkout and direct outbound internet. The job receives only its
   checkout, its job home, and the selected provider credential; it does not receive the
   Docker socket or the engine's other secret mounts. The engine itself does receive the
   host Docker socket so it can create these runners, and must be treated as a privileged
   component.
3. **open·kritt ↔ model/provider.** Repository content is sent to the configured
   OpenAI/Codex, Anthropic, OpenRouter, or xAI endpoint. That's a data-egress boundary.
4. **Host ↔ secrets.** Provider API keys and `GITHUB_TOKEN` live in `.env`. The backend
   can update that file from Accounts, and the engine passes only the selected provider
   credential into each harness job.

## Assets to protect

- **Provider credentials** (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`,
  `XAI_API_KEY`, `CODEX_API_KEY`) and the Codex/Claude login homes.
- **`GITHUB_TOKEN`** used to check out private repos.
- **Source code** of scanned repositories (often sensitive/proprietary).
- **Findings** (real vulnerabilities — sensitive until fixed/disclosed).
- **Generation requests**, which may describe private security-research goals and are
  retained in the generation queue.

## Key threats & mitigations

### 1. Untrusted code & prompt injection
The engine analyzes attacker-influenced code, and repositories can contain content crafted
to manipulate the agent (prompt injection) into exfiltrating secrets or misbehaving.

Natural-language workflow and post-script generation requests are also untrusted input.

- **Design mitigations:** every tool-enabled job receives a disposable container, a
  writable per-job checkout, a copied job home, and a dedicated Docker network. The job
  does not mount the Docker socket, database, project `.env`, or other jobs. Harness output
  is schema-constrained JSON. Draft-generation calls run with model tools, user
  rules/settings, and session persistence disabled; engine and backend validators reject
  malformed drafts before they reach an editor or resource table.
- **Deliberate capability:** scan agents run as root in their job container, may use Bash,
  install packages, compile or test the target, and access the internet directly. A job
  container is not a security boundary against a kernel or container-runtime exploit.
- **Operator mitigations:** run the complete stack on a **dedicated VM or Docker host**.
  Do not colocate it with unrelated sensitive workloads. Assume any scan could be hostile.

### 2. Secret exfiltration
A compromised/injected agent could try to read credentials or send data out.

- Keep secrets in `.env` and the provider login/credential stores (**all gitignored**); a
  `gitleaks` pre-commit hook guards against committing them. Give the engine only the
  tokens it needs.
- Prefer **narrowly scoped, short-lived** `GITHUB_TOKEN`s (read-only, only the repos you
  scan). Rotate provider keys periodically.
- Scan runners have **direct outbound internet access by default** so agents can research,
  install tools, and fetch dependencies. If your deployment requires an allowlist or no
  internet, enforce it outside open·kritt at the Docker host, firewall, or network-policy
  layer.
- `ENGINE_CODEX_AUTO_UPDATE` defaults to `false`. Enabling it additionally trusts and
  requires access to the npm registry.

### 3. Data egress to model providers
Scanning sends code to an external endpoint by default.

- Know **where your data goes** before scanning sensitive code. The supported setup paths
  use Codex/OpenAI, Anthropic, OpenRouter, or xAI (Grok Build) credentials.
- Review provider data-retention terms for the endpoints you use.

### 4. Unauthenticated API exposure
`/api/*` has **no auth** by default.

- Do not bind it to public interfaces. Put your own authentication/authorization proxy
  in front, or keep it on a trusted network only.
- Anyone who can call the API can enqueue scans or AI draft-generation jobs and consume
  provider quota. Apply authentication, network controls, and rate limits at the proxy.

### 5. Supply chain (of open·kritt itself)
- Dependencies are updated by **Dependabot** and reviewed via **Dependency Review** on
  PRs; **CodeQL** scans the code. Docker base images are **pinned** (never `:latest`).
- The engine can check the npm `@latest` Codex package at startup and daily when
  `ENGINE_CODEX_AUTO_UPDATE=true`. It is disabled by default; enabling it deliberately
  trusts the npm registry for that executable.
- Planned: SBOM generation and signed release artifacts (see the roadmap).

## Secure deployment checklist

- [ ] Run the complete stack on a **dedicated VM or Docker host**. The engine controls the
      Docker daemon, and scan runners are root with direct outbound internet access.
- [ ] Add host-level egress controls if direct internet access does not fit your policy.
- [ ] Put **auth in front of** the backend API and UI.
- [ ] Use a **minimal, short-lived `GITHUB_TOKEN`**; rotate provider keys.
- [ ] Choose a model endpoint whose **data handling** matches the sensitivity of the code.
- [ ] Keep `.env` and `.data/` credential stores private; never commit them.

## Out of scope

- Attacks requiring an already-compromised host or operator account.
- Misconfigurations explicitly warned about here (e.g. exposing the unauthenticated API to
  the internet).
- The security of third-party model providers themselves.

Vulnerabilities **in open·kritt's own code** are always in scope — report them via
[SECURITY.md](../SECURITY.md).
