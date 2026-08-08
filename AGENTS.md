# AGENTS.md

Guidance for AI/code agents (and humans skimming for the essentials) working in the
open·kritt repo. This is the canonical agent guide; `CLAUDE.md` points here.

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full contributor flow — this file is
the fast, do/don't version.

## What this is

open·kritt is an AI-driven security vulnerability scanner. It's a **polyglot
monorepo** of cooperating services:

| Path             | What                                          | Stack                         |
| ---------------- | --------------------------------------------- | ----------------------------- |
| `frontend/`      | Web UI                                        | React 18 + Vite (npm)         |
| `backend/`       | HTTP API                                      | Node + Express + Prisma (npm) |
| `engine/`        | Scan worker running the AI harnesses          | Python 3.11+ (Ruff)           |
| `database/`      | Postgres image + `init/*.sql` migrations      | Postgres 16                   |
| `executor-view/` | Executor viewer                               | Python                        |
| `scripts/`       | Repo tooling and CLI implementation           | Node                          |

The whole product ships as **one version** — the repo-root [`VERSION`](VERSION) file.

## Run / build / test

Fastest full stack: `cp .env.example .env && docker compose up --build`
(add `-f docker-compose.dev.yml` for human-readable backend logs).

For guided local onboarding, run `./kritt` for the full-screen Arrow-key menu, or use
`./kritt setup` and `./kritt start` directly (Node.js 20+ required; no npm install needed
for the CLI).

Per component:

```bash
# frontend
cd frontend && npm install
npm run dev | npm run build | npm run lint | npm run format | npm test   # Vitest

# backend  (needs DATABASE_URL; see .env.example)
cd backend && npm install
npx prisma generate && npm run migrate     # apply database/init/*.sql (idempotent)
npm run dev | npm run lint | npm run format | npm test                   # node:test

# engine
cd engine && pip install -r requirements.txt
ruff check . | ruff format . | pytest
python -m open_kritt_engine                # run the worker
```

## House rules (do)

- **Keep changes focused.** Keep unrelated edits out of the diff; add or update tests
  and documentation whenever behavior or configuration changes.
- **Conventional Commits** for every commit: `feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`, `ci:`. Scope is optional (`feat(frontend): …`), but an empty
  scope is invalid: use `feat:` or `feat(frontend):`, never `feat():`. Mark breaking
  changes with `!` or a `BREAKING CHANGE:` footer. Release effects are:
  - `feat` → minor release (patch while the project is pre-1.0)
  - `fix` → patch release
  - breaking change → minor release while pre-1.0
  - `docs`, `chore`, `refactor`, `test`, `ci` → no release on their own
- **Lint & format before proposing changes** (ESLint/Prettier for JS, Ruff for
  Python). Match the existing style; don't reformat unrelated code.
- **Never commit secrets or local data:** credentials, tokens, `.env`, provider login
  data, or scan outputs. Use the provided `gitleaks` pre-commit hook.
- **DB changes are additive, idempotent, forward-only**: a new
  `database/init/NNN_*.sql` using `CREATE ... IF NOT EXISTS` / `ADD COLUMN IF NOT
  EXISTS`, then update `backend/prisma/schema.prisma` to match and run the migration
  twice. CI also runs `migrate.js` twice to prove idempotency.
- **One version, one source of truth**: normal contributions do not bump versions. If
  a manual version change is explicitly required, change [`VERSION`](VERSION), then
  run `node scripts/sync-version.mjs`. Never hand-edit a component's version.
- **Pin Docker image tags** (never `:latest`).

## Contribution workflow

Before starting:

- Search existing issues before filing a bug or feature request.
- Use GitHub Discussions for questions, ideas, and larger proposals to avoid
  duplicated work.
- Never report a vulnerability publicly. Use the private reporting flow in
  [`SECURITY.md`](SECURITY.md); if that is unavailable, open a public issue containing
  no vulnerability details and ask for a private channel.
- External contributors should fork the repository and work on a branch. Branch names
  such as `feat/my-change` are examples, not a required naming scheme.

Before proposing a change, run the checks for every area touched:

| Area | Required local checks |
| ---- | --------------------- |
| Frontend | `cd frontend && npm install && npm run lint && npm run format:check && npm test && npm run build` |
| Backend | `cd backend && npm install && npx prisma generate && npx prisma validate && npm run lint && npm run format:check && npm test` |
| Engine | `cd engine && pip install -r requirements.txt && ruff check . && ruff format --check . && pytest` |
| CLI | `node --test scripts/kritt.test.mjs scripts/kritt-ui.test.mjs` |
| Documentation | `cd docs-site && npm run check-links` |

Engine tests are currently local-only; CI does not run them. For changes crossing
component boundaries, also run the recommended full-stack smoke test:

```bash
docker compose up --build
```

Open pull requests against `main`. Keep them small and complete the pull request
template: explain what changed and why, link the related issue (for example,
`Closes #123`), identify the change type and affected components, list checks run,
include screenshots for visible UI changes, call out breaking changes, and leave useful
reviewer notes. The PR type should match the Conventional Commit type. CI must pass
before merge.

The repository provides optional pre-commit automation:

```bash
pipx install pre-commit
pre-commit install
pre-commit run --all-files
```

It checks common file hygiene, merge-conflict markers, files over 512 KiB, YAML/JSON,
LF line endings, secrets, Ruff, Prettier, ESLint, and version synchronization.

## Contribution terms (read before submitting)

Any intentional authenticated submission for inclusion in the official repository —
including a pull request, commit, patch, or issue — constitutes agreement to the
legally binding [`CONTRIBUTION_TERMS.md`](CONTRIBUTION_TERMS.md). No DCO sign-off, CLA
trailer, separate signature, or special legal commit syntax is required.

In summary, contributors assign their transferable contribution rights jointly to
Harel Rom and Gabriel Balko and grant/waive the additional rights described in those
terms. Submission remains effective if the contribution is later rejected, closed, or
withdrawn. Only submit work you have authority to contribute; do not submit work owned
or restricted by an employer, client, university, or another agreement. Identify all
third-party material, its source, and its license. Contributions are distributed with
the project under the GNU AGPL v3.0. This summary does not replace reading the terms.

## Gotchas (don't get bitten)

- **Prisma engine is platform-specific.** A `node_modules` generated on macOS won't
  run Prisma on Linux (and vice-versa). Don't run backend/DB code against a client
  built for another OS; regenerate with `npx prisma generate` on the target platform.
- **Frontend native optional dependencies.** Rollup and esbuild ship separate
  packages per OS, architecture, and libc. Regenerate `frontend/package-lock.json`
  only from a clean dependency graph (no old lockfile or `node_modules`) so npm
  records every platform package. CI runs both `npm ci` and an Alpine/musl image
  smoke test to catch a platform-pruned lockfile.
- **Frontend version at build time** comes from `frontend/package.json` (kept in sync
  with `VERSION`), NOT `../VERSION` — the repo root isn't in the frontend Docker image.
- **Engine tests are disabled in CI for now.** Several assume a writable `/root` home
  (`~/.codex`, `~/.claude`) and one has an outdated assertion; they fail on CI runners.
  Lint-only for the engine until fixed.
- **Reserved key patterns** in scan/enrichment results are meaningful, not arbitrary:
  `_reserved_report` / `_reserved_poc` (rendered as markdown tabs) and `_chip_*`
  (post-script chips). Don't rename or strip them.
- **Custom, dependency-free Markdown renderer** lives at
  `frontend/src/components/Markdown.jsx` (escapes untrusted report/PoC text). Prefer it
  over adding a markdown dependency.
- **This is a security tool.** It runs AI agents over untrusted code and holds provider
  API keys / `GITHUB_TOKEN`. Never commit secrets (a `gitleaks` pre-commit hook helps),
  and be careful with anything that changes what data leaves the machine.

## CI / merge flow

- **CI** runs on PRs to `main` (`frontend`, `backend`, `engine`, `database`, and version
  sync). It's a required check — `main` only receives CI-passing code.
- **Release** runs on push to `main` via release-please (see [`RELEASE.md`](RELEASE.md)).
- Lint/format steps are currently `continue-on-error` until a one-time cleanup PR; keep
  new code clean so they can become hard gates.

## Where to look

- Product/dev flow: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Releases & versioning: [`RELEASE.md`](RELEASE.md)
- Security policy & threat model: [`SECURITY.md`](SECURITY.md)
