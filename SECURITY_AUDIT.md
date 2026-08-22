# Security Audit Record

This document records an informal, contributor-led security review performed on
August 13, 2026, against open·kritt `1.4.0` / `main`. It is a point-in-time review,
not a penetration test, certification, or guarantee that the project is free of
vulnerabilities.

## Scope and Method

The review covered the frontend, backend, engine, Docker Compose configuration,
credential handling, repository access, container execution, HTTP boundaries, and
dependency manifests. Static inspection focused on authentication, authorization,
input validation, secret exposure, command and path injection, browser output
encoding, container isolation, and denial-of-service controls.

Dependency checks used:

```text
cd backend && npm audit --omit=dev --package-lock-only
cd frontend && npm audit --omit=dev --package-lock-only
cd engine && pip-audit -r requirements.txt
```

## Results

- Backend: no known production dependency vulnerabilities were reported.
- Engine: no known vulnerabilities were reported in the 13 resolved Python
  packages.
- Frontend: dependency results were reviewed.
- No apparent production secrets were found by a heuristic tracked-file scan.

The review also confirmed several existing safeguards, including loopback-only
service bindings by default, restrictive default CORS behavior, bounded JSON request
bodies, local-repository path containment, escaped report rendering, and scoped job
credential environments.

## Limitations and Reporting

The review did not include dynamic penetration testing, container-escape testing,
cloud deployment assessment, or exhaustive secret-history scanning. Dependency
results reflect advisory data available on the audit date and can become stale.

Potential vulnerabilities must not be disclosed in public issues or pull requests.
Follow [`SECURITY.md`](SECURITY.md) and use GitHub private vulnerability reporting.
