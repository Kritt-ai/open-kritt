# Releasing open·kritt

open·kritt is a polyglot monorepo (frontend, backend, engine, database) that ships
as **one product** with **one version number**.

## Versioning model

- **Single source of truth:** the repo-root [`VERSION`](VERSION) file. It carries a
  trailing `# x-release-please-version` marker so release-please bumps it automatically
  (see below); tooling ignores the marker.
- Every component is kept pinned to the same version:
  - `frontend/package.json` and `backend/package.json` (`version`)
  - `engine/open_kritt_engine/__init__.py` (`__version__`)
  - the UI injects the version at build time (`frontend/vite.config.js` →
    `__APP_VERSION__`, read from the synced `frontend/package.json` since the repo-root
    `VERSION` isn't in the frontend-only Docker image), so the sidebar always shows the
    real version. An `APP_VERSION` env var overrides it if needed.
- **On a release, release-please bumps all of them together** (both `package.json`s and
  the engine via `extra-files`, plus `VERSION`), so they never drift.
- CI and the pre-commit hook run `node scripts/sync-version.mjs --check` to fail the
  build on any drift.

You rarely need to touch versions by hand. If you do (e.g. a manual/off-cycle bump),
edit the number in `VERSION` and run `node scripts/sync-version.mjs` to propagate it to
the other components.

## Stability policy (pre-1.0)

While we are on `0.x`, the project follows SemVer with the **pre-1.0 caveat that
anything may change between minor versions**:

- **Breaking changes** (HTTP API shape, DB schema, env vars, workflow/step
  semantics) may land in a **minor** bump (`0.x.0`) and will be called out in the
  [CHANGELOG](CHANGELOG.md) under a **Changed** / **BREAKING** heading.
- **Patch** releases (`0.x.y`) are additive/bug-fix only.
- **Database migrations are forward-only and idempotent.** Every change is an
  additive, `IF NOT EXISTS`-guarded file in `database/init/` and is applied by
  `backend/prisma/migrate.js`. Re-running migrations must always be safe (CI proves
  this on every PR).
- We will document a formal compatibility guarantee when we cut `1.0.0`.

## CI / branch protection

The pipeline is split by event:

- **CI** (`.github/workflows/ci.yml`) runs on **pull requests targeting `main`**.
- **Release** (`.github/workflows/release.yml`) runs on **push to `main`**.

To guarantee that only CI-passing code reaches `main` (and therefore that releases
are only ever cut from green builds), make CI a **required status check** via branch
protection — a one-time repo setting:

**Settings → Branches → Add branch ruleset (or protection rule) for `main`:**
- ✅ Require a pull request before merging
- ✅ Require status checks to pass before merging → select the CI jobs
  (`frontend`, `backend`, `engine`, `database`, `version sync`)
- ✅ (recommended) Require branches to be up to date before merging
- ✅ (recommended) Block force pushes

With this on, direct pushes to `main` are rejected; changes land only by merging a PR
whose CI is green — which then triggers the Release workflow.

## One-time repo setup (release PR permissions)

release-please opens its release PR with the Actions token, which GitHub blocks by
default (*"GitHub Actions is not permitted to create or approve pull requests."*).
Pick **one**:

**Option A — repo/org setting.** Settings → Actions → General → Workflow permissions →
"Read and write permissions" + "Allow GitHub Actions to create and approve pull
requests".

> If that checkbox is **greyed out**, the policy is enforced at the **organization**
> level. An org owner must enable it under the org's Actions settings — or use
> Option B (which doesn't need org changes).

**Option B — provide a token (recommended for orgs).** Create a fine-grained PAT
scoped to this repo with **Contents: read/write** + **Pull requests: read/write**
(or a GitHub App token), and add it as the repo secret **`RELEASE_PLEASE_TOKEN`**.
`release.yml` already prefers this secret and falls back to the default token, so no
workflow edit is needed. Bonus: a PAT/App-authored release PR also triggers CI (the
default Actions token does not).

## Commit convention

Releases are automated from [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: …` → minor bump (pre-1.0: patch — see `release-please-config.json`)
- `fix: …` → patch bump
- `feat!: …` / `BREAKING CHANGE:` → minor bump (pre-1.0)
- `docs:`, `chore:`, `refactor:`, `test:`, `ci:` → no release on their own

> **Scope is optional, but never use empty parentheses.** `feat():` is *invalid in*
> Conventional Commits and release-please silently skips it (`unexpected token ')'`).
> Write `feat:` (no scope) or `feat(frontend):` (with a scope) — not `feat()`.

## Cutting a release

We use [release-please](https://github.com/googleapis/release-please)
(`.github/workflows/release.yml`). It runs on **push to `main`**; because branch
protection only lets CI-passing PRs merge into `main`, releases are never cut from a
red build.

1. Merge Conventional-Commit PRs into `main`. release-please maintains a rolling
   **"chore(main): release x.y.z"** pull request that bumps the version everywhere —
   `backend/package.json`, `frontend/package.json`, `engine/…/__init__.py`, **and the
   root `VERSION` file** (via the `x-release-please-version` marker) — and updates
   `CHANGELOG.md`. Because all four move together, the `versions` CI check passes on the
   release PR with no manual step.
2. **Merge the release PR.** release-please creates the git tag (`vX.Y.Z`) and the
   GitHub Release with generated notes.

> Container image build & publish is intentionally **not** wired up yet; it will be
> added as a separate release step later.

## Manual / pre-automation release (fallback)

If you need to cut a release by hand:

```bash
# Keep the release-please marker on the line:
echo "0.5.0 # x-release-please-version" > VERSION
node scripts/sync-version.mjs        # propagate to package.json files + engine
# update CHANGELOG.md (move Unreleased → 0.5.0)
git commit -am "chore(release): 0.5.0"
git tag v0.5.0 && git push --tags
```
