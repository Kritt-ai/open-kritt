# Security Hardening Roadmap

This roadmap collects public, defense-in-depth improvements for open·kritt. It is
not a vulnerability disclosure or a release commitment. Suspected vulnerabilities
must follow the private reporting process in [`SECURITY.md`](SECURITY.md).

## Priority 1: Trust Boundaries

- **Protect network-exposed APIs.** Build on the deployment controls in
  [`docs/threat-model.md`](docs/threat-model.md#4-unauthenticated-api-exposure) by
  evaluating optional native API authentication. Acceptance: protected deployments
  reject unauthenticated requests while health checks remain available.
- **Reduce Docker daemon access.** Evaluate a restricted Docker API proxy or a
  dedicated runner service in place of direct daemon-socket access. Acceptance: the
  engine can manage scan containers and networks but cannot request unrelated daemon
  operations.
- **Harden job containers.** Test capability dropping, `no-new-privileges`, a
  read-only root filesystem, and CPU limits across every supported harness.
  Acceptance: scans retain required tooling while unnecessary container privileges
  are removed.

## Priority 2: Application Controls

- **Add browser security headers.** Define CSP, framing, MIME-sniffing, and referrer
  policies compatible with the bundled frontend. Configure HSTS only at confirmed
  HTTPS boundaries.
- **Bound expensive API work.** Add measured rate or concurrency limits to scan
  creation, generation, provider-login, and repository-stat operations. Acceptance:
  limits return predictable errors without interrupting existing work.
- **Expand security regression coverage.** Verify loopback defaults, credential
  redaction, repository-path containment, and safe runner arguments.

## Priority 3: Maintenance and CI

- **Make frontend tests deterministic.** Pass explicit locale and time-zone inputs
  where rendered dates are asserted so tests agree across operating systems.
- **Enable engine tests in CI.** Resolve the local-only constraints documented in
  [`CONTRIBUTING.md`](CONTRIBUTING.md), then make the suite a required check.
- **Extend dependency auditing.** Add Python requirement auditing alongside the
  existing Dependabot, Dependency Review, and CodeQL controls documented in
  [`docs/threat-model.md`](docs/threat-model.md#5-supply-chain-of-openkritt-itself).

Implement items independently with tests appropriate to each trust boundary. Avoid
combining them into a broad security rewrite.
