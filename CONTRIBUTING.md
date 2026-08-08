# Contributing to open·kritt

Thanks for helping improve open·kritt. Please follow our
[Code of Conduct](CODE_OF_CONDUCT.md) when participating.

## Before you start

- Search [existing issues](https://github.com/Kritt-ai/open-kritt/issues) before
  reporting a bug or requesting a feature.
- Use [Discussions](https://github.com/Kritt-ai/open-kritt/discussions) for questions,
  ideas, and larger proposals. Starting there can prevent duplicated work.
- Never report a vulnerability publicly. Follow [SECURITY.md](SECURITY.md) to submit
  it privately.

## Set up the project

You need Git, Docker with Docker Compose, and Node.js 20 or newer. Fork the
repository, then:

```bash# 1. Get the code
#    External contributors: fork on GitHub, then clone your fork:
git clone https://github.com/<you>/open-kritt && cd open-kritt

# 2. Configure model access and bring the whole stack up
./kritt setup
./kritt start

# 3. Make changes on a branch and use Conventional Commits
git checkout -b feat/my-change
git commit -m "feat(frontend): add X"

# 4. Push and open a PR against main. CI must pass before it can merge.

```

These commands configure the environment and start the full stack. See the
[installation guide](https://docs.kritt.ai/getting-started/installation-and-setup)
for more detail.

## Make and validate your change

Keep each change focused. Add or update tests and documentation when behavior changes,
then run the checks for every area you touched:

| Area | Checks |
| --- | --- |
| Frontend | `cd frontend && npm install && npm run lint && npm run format:check && npm test && npm run build` |
| Backend | `cd backend && npm install && npx prisma generate && npx prisma validate && npm run lint && npm run format:check && npm test` |
| Engine | `cd engine && pip install -r requirements.txt && ruff check . && ruff format --check . && pytest` |
| CLI | `node --test scripts/kritt.test.mjs scripts/kritt-ui.test.mjs` |
| Documentation | `cd docs-site && npm run check-links` |

Engine tests currently run locally but are not enabled in CI. A full-stack smoke test is
recommended for changes that cross component boundaries:

```bash
docker compose up --build
```

## Project rules

- Never commit credentials, tokens, `.env`, or local scan data.
- Database changes must use a new numbered SQL file in `database/init/`. Migrations
  must be additive, forward-only, and safe to run repeatedly; update
  `backend/prisma/schema.prisma` to match and run `npm run migrate` twice.
- `VERSION` is the product version's source of truth. Normal contributions should not
  bump it. If a version change is required, edit `VERSION` and run
  `node scripts/sync-version.mjs`.
- Keep Docker image tags pinned.
- Read the repository-specific [agent and contributor gotchas](AGENTS.md) before
  changing dependency lockfiles, Prisma setup, result keys, or Markdown rendering.

## Commit your change

Every commit must use [Conventional Commits](https://www.conventionalcommits.org/):

```bash
git commit -m "fix(frontend): describe the change"
```

Common types are `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, and `ci`. A scope
is optional; use `feat:` or `feat(frontend):`, never `feat():`.

## Contribution terms

By intentionally submitting a pull request, commit, patch, or other contribution, you
agree to the [Contribution Terms](CONTRIBUTION_TERMS.md), including assignment of your
transferable rights in the contribution jointly to
[Harel Rom and Gabriel Balko](OWNERSHIP.md). Do not submit work that an employer, client,
university, or another party owns or restricts.

No separate signature, contributor agreement, form, checkbox, registry, or special
commit syntax is required. The ordinary act of submitting the contribution is the only
assent step.

## Open a pull request

Push your branch and open a pull request against `main`. In the pull request:

- Explain what changed and why, and link the related issue.
- List the checks you ran.
- Include screenshots for visible UI changes.
- Keep unrelated changes out of the diff.
- Complete the pull request template and make sure CI passes.

Contributions are distributed as part of the project under the repository's
[GNU AGPL v3.0 license](LICENSE).
