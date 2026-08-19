# Security Policy

open·kritt is a security tool: it runs AI agents over (potentially untrusted) source
code and handles model API keys and repository credentials. We take the security of
the project — and of the people who run it — seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's built-in **private vulnerability reporting**:

**→ [Report a vulnerability](https://github.com/Kritt-ai/open-kritt/security/advisories/new)**

Or navigate there manually:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** (under "Advisories").
3. Fill in the details and submit.

This opens a private advisory visible only to you and the maintainers. If you can't
use that flow, open a regular issue that says only *"I'd like to report a security
issue privately, please enable a private channel"* — with **no details** — and a
maintainer will follow up.

### What to include

- A description of the issue and its impact.
- Steps to reproduce (proof-of-concept, affected component: `frontend` / `backend` /
  `engine` / `database`).
- Affected version (see the root `VERSION` file) and configuration.
- Any suggested remediation.

### What to expect

- **Acknowledgement:** within 3 business days.
- **Assessment & triage:** we'll confirm the issue and share a rough timeline.
- **Fix & disclosure:** we aim to release a fix and a coordinated advisory as soon as
  practical. We're happy to credit you in the advisory unless you prefer to remain
  anonymous.

Please give us reasonable time to remediate before any public disclosure.

## Supported versions

Security fixes land on the **latest** release and `main`; we do not backport to older
minor release lines. Please reproduce on the latest version before reporting.

| Version | Supported |
| ------- | --------- |
| latest `1.x` / `main` | ✅ |
| older release lines | ❌ |

## Scope & threat model (for operators)

Because open·kritt executes AI agents against arbitrary repositories, keep these in
mind when self-hosting:

- **Untrusted code is analyzed, not trusted.** Run the engine/executor in an isolated
  environment. Scan agents run as root in disposable containers with writable workspaces
  and direct internet access. Use a dedicated VM or Docker host and treat scanned
  repositories and model output as untrusted input.
- **Secrets.** Model/provider API keys and `GITHUB_TOKEN` live in your gitignored `.env`;
  provider logins live under `.data/`. Accounts gives the backend write access to those
  stores so changes persist. Scope tokens minimally and rotate them. Never commit
  secrets; the repo ships a `gitleaks` pre-commit hook to help.
- **Data egress.** Scans send repository content to whichever model/provider endpoint
  you configure (Codex/OpenAI, Anthropic, OpenRouter, or xAI). Understand where that data
  goes before scanning sensitive code.
- **Network.** The backend API is unauthenticated by default; do not
  expose it to untrusted networks without putting your own auth/proxy in front.

Reports about the security *of the open·kritt codebase itself* are always in scope.
Findings that require an already-compromised host, or that are inherent to a
misconfiguration explicitly warned about above, may be considered out of scope — but
when in doubt, report it.

## For maintainers: enabling private reporting

Private vulnerability reporting must be turned on for the repo (one-time):

> **Settings → Code security and analysis → Private vulnerability reporting → Enable**

(Org owners can enable it org-wide under the organization's Code security settings.)
Once enabled, the **Security → Report a vulnerability** button appears for reporters.
