INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'cloudflare-security-audit',
    'Cloudflare security audit',
    'Optional external security-audit skill reference for exploitable vulnerabilities with real impact across services, APIs, CLIs, libraries, and daemons.',
    $skill$
Use this optional external skill reference when a scan needs a broad, impact-focused security audit.

Focus:
- Find exploitable vulnerabilities with realistic attacker control and meaningful impact.
- Map entry points before reporting findings.
- Trace data and control flow from attacker input to security-sensitive sinks or invariants.
- Use subagents when useful for independent codebase exploration, lead validation, and false-positive reduction.
- Prefer concrete evidence over pattern-only findings.
- Exclude theoretical concerns, accepted framework behavior, dead code, tests, examples, and issues without a reachable attack path.

Source/license:
- Upstream source is Cloudflare's security-audit skill.
- MIT licensed. Preserve upstream attribution if importing the full upstream skill body separately.
$skill$,
    'https://github.com/cloudflare/security-audit-skill/blob/main/SKILL.md',
    'MIT',
    'References Cloudflare security-audit-skill metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'cloudflare-security-audit');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'github-security-review',
    'GitHub security review',
    'Optional external security-review skill reference for tracing code flows and finding vulnerabilities that pattern matching may miss.',
    $skill$
Use this optional external skill reference when a scan should behave like a general security reviewer across common application stacks.

Focus:
- Inspect injection risks, authentication and authorization logic, secrets exposure, weak cryptography, insecure dependencies, and business-logic abuse.
- Follow source-to-sink flows instead of relying only on grep-style indicators.
- Verify component interactions, framework middleware, route registration, background jobs, and dependency boundaries.
- Report only issues with a plausible exploit path, affected code anchors, and concrete remediation.

Source/license:
- Upstream source is GitHub's awesome-copilot security-review skill.
- MIT licensed. Preserve upstream attribution if importing the full upstream skill body separately.
$skill$,
    'https://github.com/github/awesome-copilot/blob/main/skills/security-review/SKILL.md',
    'MIT',
    'References GitHub awesome-copilot security-review metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'github-security-review');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'pashov-solidity-auditor',
    'Pashov Solidity auditor',
    'Optional external Solidity audit skill reference for smart-contract vulnerability discovery.',
    $skill$
Use this optional external skill reference for Solidity and EVM protocol audits.

Focus:
- Review production Solidity contracts, excluding tests, mocks, interfaces, and vendored libraries unless they are production dependencies.
- Build an asset-flow and trust-boundary map before issue hunting.
- Prioritize missing authorization, broken accounting, oracle manipulation, rounding, reentrancy, unsafe external calls, upgrade and initializer mistakes, signature replay, and loss-of-funds sequences.
- Validate each lead with an attacker transaction sequence and explain why modifiers, guards, or invariants do not prevent it.

Source/license:
- Upstream source is Pashov's solidity-auditor skill.
- MIT licensed. Preserve upstream attribution if importing the full upstream skill body separately.
$skill$,
    'https://github.com/pashov/skills/blob/main/solidity-auditor/SKILL.md',
    'MIT',
    'References Pashov Audit Group pashov/skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'pashov-solidity-auditor');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'pashov-xray',
    'Pashov X-Ray',
    'Optional external pre-audit reconnaissance skill reference for protocol overview, threat modeling, invariants, integrations, and risk surfaces.',
    $skill$
Use this optional external skill reference when a scan needs pre-audit reconnaissance before deep vulnerability hunting.

Focus:
- Summarize protocol/application architecture, privileged actors, trust boundaries, externally callable surfaces, integrations, and documentation quality.
- Extract invariants and rank attack surfaces by git activity, code complexity, value movement, and composability dependencies.
- Identify concrete targets for later review: dispatchers, permission checks, accounting updates, oracle reads, bridge verifiers, settlement logic, and upgrade hooks.
- Feed actionable targets into subsequent workflow steps instead of stopping at architecture notes.

Source/license:
- Upstream source is Pashov's x-ray skill.
- MIT licensed. Preserve upstream attribution if importing the full upstream skill body separately.
$skill$,
    'https://github.com/pashov/skills/blob/main/x-ray/SKILL.md',
    'MIT',
    'References Pashov Audit Group pashov/skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'pashov-xray');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'pashov-fizz',
    'Pashov Fizz fuzzing',
    'Optional external Solidity fuzzing skill reference for Echidna/Medusa-compatible invariant and stateful fuzz suites.',
    $skill$
Use this optional external skill reference when a Solidity scan should propose or reason about fuzzing and invariant harnesses.

Focus:
- Identify stateful invariants around accounting, authorization, token conservation, oracle assumptions, deposits, withdrawals, liquidations, and upgrades.
- Prefer harnesses that reuse existing Foundry or Hardhat setup rather than inventing deployments.
- Keep generated fuzz tests isolated from production code unless explicitly requested.
- Use fuzzing to validate or falsify concrete vulnerability hypotheses, not as a replacement for exploit reasoning.

Source/license:
- Upstream source is Pashov's fizz skill.
- MIT licensed. Preserve upstream attribution if importing the full upstream skill body separately.
$skill$,
    'https://github.com/pashov/skills/blob/main/fizz/SKILL.md',
    'MIT',
    'References Pashov Audit Group pashov/skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'pashov-fizz');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'trail-of-bits-entry-point-analyzer',
    'Trail of Bits entry-point analyzer',
    'Optional external Trail of Bits entry-point analysis reference for enumerating realistic attacker-controlled ingress.',
    $skill$
Use this optional external skill reference when a scan should emphasize complete entry-point discovery.

Focus:
- Enumerate externally reachable HTTP/RPC routes, CLI commands, protocol messages, peer inputs, deserializers, public package exports, scheduled jobs, webhook handlers, smart-contract calls, and validator/client inputs.
- Classify attacker capabilities, authentication requirements, data shapes, and downstream handlers.
- Use discovered entry points to constrain later vulnerability reports to reachable production paths.

Source/license:
- Upstream source is Trail of Bits' entry-point-analyzer skill.
- Trail of Bits skills are CC-BY-SA-4.0. This row is concise bridge text only. Preserve attribution and ShareAlike obligations if importing the full upstream skill body separately.
$skill$,
    'https://github.com/trailofbits/skills/blob/main/plugins/entry-point-analyzer/skills/entry-point-analyzer/SKILL.md',
    'CC-BY-SA-4.0',
    'References Trail of Bits skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'trail-of-bits-entry-point-analyzer');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'trail-of-bits-variant-analysis',
    'Trail of Bits variant analysis',
    'Optional external Trail of Bits variant-analysis reference for finding sibling bugs after one concrete pattern is identified.',
    $skill$
Use this optional external skill reference when a scan should search for variants of a known bug pattern.

Focus:
- Generalize the root cause, not just the surface symptom.
- Search sibling modules, alternate protocol versions, generated code, bindings, adapters, and dependency wrappers.
- Verify each variant independently for reachability, attacker control, and impact.
- Avoid reporting clones that lack the original exploit preconditions.

Source/license:
- Upstream source is Trail of Bits' variant-analysis skill.
- Trail of Bits skills are CC-BY-SA-4.0. This row is concise bridge text only. Preserve attribution and ShareAlike obligations if importing the full upstream skill body separately.
$skill$,
    'https://github.com/trailofbits/skills/blob/main/plugins/variant-analysis/skills/variant-analysis/SKILL.md',
    'CC-BY-SA-4.0',
    'References Trail of Bits skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'trail-of-bits-variant-analysis');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'trail-of-bits-static-analysis',
    'Trail of Bits static analysis',
    'Optional external Trail of Bits static-analysis reference for using Semgrep, CodeQL, SARIF, and manual validation together.',
    $skill$
Use this optional external skill reference when a scan should combine static-analysis tooling with manual security reasoning.

Focus:
- Use static-analysis patterns to discover candidates, then manually prove reachability and impact.
- Treat Semgrep, CodeQL, SARIF, and similar outputs as leads rather than findings.
- Reduce false positives by tracing attacker-controlled data, checking framework semantics, and confirming production configuration.
- When a tool result maps to a real bug, report the exact source, sink, sanitizer gap, and exploit sequence.

Source/license:
- Upstream source is Trail of Bits' static-analysis plugin skills.
- Trail of Bits skills are CC-BY-SA-4.0. This row is concise bridge text only. Preserve attribution and ShareAlike obligations if importing the full upstream skill body separately.
$skill$,
    'https://github.com/trailofbits/skills/tree/main/plugins/static-analysis/skills',
    'CC-BY-SA-4.0',
    'References Trail of Bits skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'trail-of-bits-static-analysis');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'trail-of-bits-supply-chain-risk',
    'Trail of Bits supply-chain risk',
    'Optional external Trail of Bits supply-chain risk reference for dependency, build, package, and release-path review.',
    $skill$
Use this optional external skill reference when a scan should review software supply-chain risk.

Focus:
- Inspect dependency execution hooks, package scripts, generated code, binary downloads, vendored code, lockfiles, build plugins, CI release steps, and update mechanisms.
- Prioritize paths that execute during build, install, test, release, or production startup.
- Distinguish operational hygiene from exploitable compromise paths.
- Report realistic attacker prerequisites and the resulting code execution, credential exposure, package takeover, or artifact tampering impact.

Source/license:
- Upstream source is Trail of Bits' supply-chain-risk-auditor skill.
- Trail of Bits skills are CC-BY-SA-4.0. This row is concise bridge text only. Preserve attribution and ShareAlike obligations if importing the full upstream skill body separately.
$skill$,
    'https://github.com/trailofbits/skills/blob/main/plugins/supply-chain-risk-auditor/skills/supply-chain-risk-auditor/SKILL.md',
    'CC-BY-SA-4.0',
    'References Trail of Bits skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'trail-of-bits-supply-chain-risk');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'trail-of-bits-solana-scanner',
    'Trail of Bits Solana scanner',
    'Optional external Trail of Bits Solana vulnerability-scanner reference for Solana programs, clients, runtimes, and protocol code.',
    $skill$
Use this optional external skill reference for Solana programs, validators, runtimes, and protocol clients.

Focus:
- Track transactions, instructions, accounts, sysvars, signatures, feature gates, validator inputs, replay behavior, bank state, and dependency/reference implementations.
- Review authorization, signer/account constraints, account ownership, CPI, PDA derivation, serialization, arithmetic, rent/fees/rewards, precompiles, syscalls, and consensus-sensitive runtime behavior.
- For client/runtime code, compare against the supplied reference implementation when available and report only externally triggerable divergences.

Source/license:
- Upstream source is Trail of Bits' Solana vulnerability scanner skill.
- Trail of Bits skills are CC-BY-SA-4.0. This row is concise bridge text only. Preserve attribution and ShareAlike obligations if importing the full upstream skill body separately.
$skill$,
    'https://github.com/trailofbits/skills/blob/main/plugins/building-secure-contracts/skills/solana-vulnerability-scanner/SKILL.md',
    'CC-BY-SA-4.0',
    'References Trail of Bits skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'trail-of-bits-solana-scanner');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'sentry-security-review',
    'Sentry security review',
    'Optional external Sentry security-review skill reference for high-confidence vulnerability review across application code.',
    $skill$
Use this optional external skill reference when a scan needs a broad, high-confidence application security review.

Focus:
- Research the whole codebase before reporting on a file, diff, or finding.
- Confirm attacker-controlled input, reachable sinks, missing framework protections, and security impact.
- Prioritize injection, XSS, authentication, authorization, cryptography, SSRF, deserialization, file handling, and supply-chain risks.
- Avoid pattern-only reports, test-only code, constants, server-controlled configuration, and issues mitigated by framework defaults.

Source/license:
- Upstream source is Sentry's security-review skill.
- Apache-2.0 licensed. Preserve upstream attribution if importing the full upstream skill body separately.
$skill$,
    'https://github.com/getsentry/skills/blob/main/skills/security-review/SKILL.md',
    'Apache-2.0',
    'References Sentry getsentry/skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'sentry-security-review');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'sentry-github-actions-security-review',
    'Sentry GitHub Actions security review',
    'Optional external Sentry GHA security-review skill reference for exploitable workflow and CI/CD attack paths.',
    $skill$
Use this optional external skill reference when a scan should review GitHub Actions workflows for realistic exploitation.

Focus:
- Review workflow triggers, permissions, secrets, checkout behavior, local actions, reusable workflows, caches, artifacts, and self-hosted runners.
- Model an external attacker who can open fork PRs, create issues, or comment, but cannot push to protected branches.
- Prioritize pull_request_target abuse, expression injection, command parsing, credential escalation, unpinned actions, AI prompt injection through CI, and supply-chain compromise.
- Require concrete entry point, payload, execution mechanism, impact, and proof-of-concept sketch for high-confidence findings.

Source/license:
- Upstream source is Sentry's gha-security-review skill.
- Apache-2.0 licensed. Preserve upstream attribution if importing the full upstream skill body separately.
$skill$,
    'https://github.com/getsentry/skills/blob/main/skills/gha-security-review/SKILL.md',
    'Apache-2.0',
    'References Sentry getsentry/skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'sentry-github-actions-security-review');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'sentry-django-access-review',
    'Sentry Django access review',
    'Optional external Sentry Django access-control skill reference for IDOR, authorization, and tenant-isolation review.',
    $skill$
Use this optional external skill reference when a scan targets Django or Django REST Framework authorization.

Focus:
- Build the codebase-specific authorization model before looking for bugs.
- Trace views, serializers, permission classes, decorators, middleware, base classes, custom managers, and get_queryset overrides.
- Check whether one user, role, tenant, or organization can access or mutate another user's resources.
- Report only confirmed authorization bypasses with reachable endpoint, required identity, missing object scope, and expected remediation.

Source/license:
- Upstream source is Sentry's django-access-review skill.
- Apache-2.0 licensed. Preserve upstream attribution if importing the full upstream skill body separately.
$skill$,
    'https://github.com/getsentry/skills/blob/main/skills/django-access-review/SKILL.md',
    'Apache-2.0',
    'References Sentry getsentry/skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'sentry-django-access-review');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'factory-security-review',
    'Factory security review',
    'Optional external Factory AI security-review skill reference for STRIDE-based repository and PR vulnerability review.',
    $skill$
Use this optional external skill reference when a scan should combine threat modeling with repository or PR security review.

Focus:
- Build or consult a threat model before scanning for specific vulnerabilities.
- Review changed files and full repository context for STRIDE categories and known vulnerability patterns.
- Validate findings for exploitability before producing downstream reports or patches.
- Prefer structured findings that include affected component, attack path, severity, evidence, and suggested fix.

Source/license:
- Upstream source is Factory AI's security-review skill.
- MIT licensed. Preserve upstream attribution if importing the full upstream skill body separately.
$skill$,
    'https://github.com/Factory-AI/skills/blob/main/skills/security-review/SKILL.md',
    'MIT',
    'References Factory AI Factory-AI/skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'factory-security-review');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'factory-threat-model-generation',
    'Factory threat model generation',
    'Optional external Factory AI threat-model skill reference for STRIDE architecture and trust-boundary mapping.',
    $skill$
Use this optional external skill reference when a scan needs a threat model before vulnerability hunting.

Focus:
- Identify languages, frameworks, services, entry points, data stores, external interfaces, and background jobs.
- Map trust boundaries between public, authenticated, internal, administrative, and third-party zones.
- Trace sensitive data flows and security controls around authentication, authorization, validation, encryption, logging, and deployment.
- Turn architecture knowledge into concrete review targets and reusable scan context.

Source/license:
- Upstream source is Factory AI's threat-model-generation skill.
- MIT licensed. Preserve upstream attribution if importing the full upstream skill body separately.
$skill$,
    'https://github.com/Factory-AI/skills/blob/main/skills/threat-model-generation/SKILL.md',
    'MIT',
    'References Factory AI Factory-AI/skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'factory-threat-model-generation');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'factory-vulnerability-validation',
    'Factory vulnerability validation',
    'Optional external Factory AI vulnerability-validation skill reference for exploitability checks and false-positive reduction.',
    $skill$
Use this optional external skill reference when a scan needs to validate suspected findings before reporting or patching.

Focus:
- Classify reachability from external, authenticated, internal, or unreachable entry points.
- Trace attacker control from source to sink through transformations, validators, framework middleware, and guard conditions.
- Build a minimal exploit narrative or proof-of-concept sketch where appropriate.
- Mark false positives explicitly when prerequisites, data control, or impact do not hold.

Source/license:
- Upstream source is Factory AI's vulnerability-validation skill.
- MIT licensed. Preserve upstream attribution if importing the full upstream skill body separately.
$skill$,
    'https://github.com/Factory-AI/skills/blob/main/skills/vulnerability-validation/SKILL.md',
    'MIT',
    'References Factory AI Factory-AI/skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'factory-vulnerability-validation');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'factory-commit-security-scan',
    'Factory commit security scan',
    'Optional external Factory AI commit-security-scan skill reference for PR, staged, and commit-range vulnerability review.',
    $skill$
Use this optional external skill reference when a scan should focus on changed code rather than a whole repository.

Focus:
- Determine scope from a PR, staged diff, commit, branch comparison, or recent commit range.
- Read full file context around changed lines before judging security impact.
- Compare changes against an existing threat model or generate scan context when it is missing.
- Report only changed-code vulnerabilities with clear diff relevance, exploitability, and remediation path.

Source/license:
- Upstream source is Factory AI's commit-security-scan skill.
- MIT licensed. Preserve upstream attribution if importing the full upstream skill body separately.
$skill$,
    'https://github.com/Factory-AI/skills/blob/main/skills/commit-security-scan/SKILL.md',
    'MIT',
    'References Factory AI Factory-AI/skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'factory-commit-security-scan');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'netresearch-security-audit',
    'Netresearch security audit',
    'Optional external Netresearch security-audit skill reference for OWASP, CWE, CVSS, cloud, IaC, API, frontend, LLM, PHP, and TYPO3 review.',
    $skill$
Use this optional external skill reference when a scan needs broad security-audit coverage across application and infrastructure code.

Focus:
- Review OWASP Top 10, API, LLM, CWE Top 25, CVSS scoring, secure coding, and modern attack classes.
- Cover injection, XXE, XSS, CSRF, command injection, path traversal, file upload, deserialization, SSRF, SSTI, JWT, type juggling, and auth flaws.
- Include cloud and infrastructure surfaces such as AWS, Azure, GCP, Terraform, Kubernetes, Docker, Helm, GitHub Actions, and dependency supply chain.
- Apply deeper PHP, TYPO3, Symfony, Laravel, API, frontend, and AI-agent configuration checks when those stacks are present.

Source/license:
- Upstream source is Netresearch's security-audit skill.
- Upstream declares MIT AND CC-BY-SA-4.0. Preserve attribution and ShareAlike obligations if importing the full upstream skill body separately.
$skill$,
    'https://github.com/netresearch/security-audit-skill/blob/main/skills/security-audit/SKILL.md',
    'MIT AND CC-BY-SA-4.0',
    'References Netresearch security-audit-skill metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'netresearch-security-audit');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'trail-of-bits-agentic-actions-auditor',
    'Trail of Bits agentic actions auditor',
    'Optional external Trail of Bits skill reference for GitHub Actions workflows that invoke AI coding agents.',
    $skill$
Use this optional external skill reference when a scan should audit CI workflows that run AI coding agents.

Focus:
- Find workflows invoking Claude Code Action, Gemini CLI, OpenAI Codex, GitHub AI Inference, or similar agentic steps.
- Trace attacker-controlled GitHub event data through env blocks, prompts, action inputs, composite actions, and reusable workflows.
- Review sandbox configuration, tool permissions, wildcard allowlists, prompt construction, and external input triggers.
- Report only CI agent attack paths with realistic trigger, data flow, agent capability, and impact.

Source/license:
- Upstream source is Trail of Bits' agentic-actions-auditor skill.
- Trail of Bits skills are CC-BY-SA-4.0. This row is concise bridge text only. Preserve attribution and ShareAlike obligations if importing the full upstream skill body separately.
$skill$,
    'https://github.com/trailofbits/skills/blob/main/plugins/agentic-actions-auditor/skills/agentic-actions-auditor/SKILL.md',
    'CC-BY-SA-4.0',
    'References Trail of Bits skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'trail-of-bits-agentic-actions-auditor');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'trail-of-bits-audit-context-building',
    'Trail of Bits audit context building',
    'Optional external Trail of Bits skill reference for deep line-by-line audit context before vulnerability hunting.',
    $skill$
Use this optional external skill reference when a scan needs deeper architectural understanding before reporting bugs.

Focus:
- Analyze important functions, modules, and flows bottom-up before judging vulnerability likelihood.
- Capture invariants, assumptions, trust boundaries, data ownership, state transitions, and reasoning hazards.
- Link low-level observations to system-wide security properties.
- Use the resulting context to reduce hallucinated findings and guide later vulnerability hunting.

Source/license:
- Upstream source is Trail of Bits' audit-context-building skill.
- Trail of Bits skills are CC-BY-SA-4.0. This row is concise bridge text only. Preserve attribution and ShareAlike obligations if importing the full upstream skill body separately.
$skill$,
    'https://github.com/trailofbits/skills/blob/main/plugins/audit-context-building/skills/audit-context-building/SKILL.md',
    'CC-BY-SA-4.0',
    'References Trail of Bits skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'trail-of-bits-audit-context-building');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'trail-of-bits-burpsuite-project-parser',
    'Trail of Bits Burp Suite project parser',
    'Optional external Trail of Bits skill reference for extracting HTTP traffic and findings from Burp Suite project files.',
    $skill$
Use this optional external skill reference when a scan has Burp Suite project evidence available.

Focus:
- Search captured proxy history, site maps, request bodies, response bodies, and headers for security-relevant patterns.
- Extract audit findings and HTTP evidence from Burp project files when the required tooling is available.
- Correlate captured requests with source-code entry points, authentication state, and observed application behavior.
- Treat traffic as evidence for reachability and exploitability, not as a substitute for code review.

Source/license:
- Upstream source is Trail of Bits' burpsuite-project-parser skill.
- Trail of Bits skills are CC-BY-SA-4.0. This row is concise bridge text only. Preserve attribution and ShareAlike obligations if importing the full upstream skill body separately.
$skill$,
    'https://github.com/trailofbits/skills/blob/main/plugins/burpsuite-project-parser/skills/burpsuite-project-parser/SKILL.md',
    'CC-BY-SA-4.0',
    'References Trail of Bits skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'trail-of-bits-burpsuite-project-parser');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'trail-of-bits-c-review',
    'Trail of Bits C/C++ review',
    'Optional external Trail of Bits skill reference for native userspace C and C++ security review.',
    $skill$
Use this optional external skill reference when a scan targets native C or C++ userspace code.

Focus:
- Review memory corruption, integer overflows, type confusion, use-after-free, lifetime bugs, parsing bugs, race conditions, and platform-specific security mistakes.
- Prioritize daemons, services, parsers, network inputs, file formats, IPC, privilege boundaries, and attacker-controlled buffers.
- Build concrete crash, corruption, information leak, or control-flow impact narratives.
- Exclude kernel and embedded targets unless the scan explicitly asks for that scope.

Source/license:
- Upstream source is Trail of Bits' c-review skill.
- Trail of Bits skills are CC-BY-SA-4.0. This row is concise bridge text only. Preserve attribution and ShareAlike obligations if importing the full upstream skill body separately.
$skill$,
    'https://github.com/trailofbits/skills/blob/main/plugins/c-review/skills/c-review/SKILL.md',
    'CC-BY-SA-4.0',
    'References Trail of Bits skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'trail-of-bits-c-review');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'trail-of-bits-constant-time-analysis',
    'Trail of Bits constant-time analysis',
    'Optional external Trail of Bits skill reference for timing side-channel review in cryptographic and secret-handling code.',
    $skill$
Use this optional external skill reference when a scan should review code for secret-dependent timing leakage.

Focus:
- Identify secret-dependent branches, table lookups, divisions, memory access patterns, early exits, parsing shortcuts, and logging of sensitive values.
- Review C, C++, Go, Rust, Swift, Java, Kotlin, C#, PHP, JavaScript, TypeScript, Python, and Ruby crypto-adjacent code.
- Separate public inputs from secrets before reporting.
- Recommend constant-time primitives or redesigns only when the leak is reachable and security-relevant.

Source/license:
- Upstream source is Trail of Bits' constant-time-analysis skill.
- Trail of Bits skills are CC-BY-SA-4.0. This row is concise bridge text only. Preserve attribution and ShareAlike obligations if importing the full upstream skill body separately.
$skill$,
    'https://github.com/trailofbits/skills/blob/main/plugins/constant-time-analysis/skills/constant-time-analysis/SKILL.md',
    'CC-BY-SA-4.0',
    'References Trail of Bits skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'trail-of-bits-constant-time-analysis');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'trail-of-bits-fp-check',
    'Trail of Bits false-positive check',
    'Optional external Trail of Bits skill reference for validating suspected security findings and eliminating false positives.',
    $skill$
Use this optional external skill reference when a scan needs a verdict on whether a specific suspected finding is real.

Focus:
- Verify reachability, attacker control, preconditions, mitigations, and impact for each suspected bug.
- Produce a clear true-positive or false-positive verdict with supporting evidence.
- Use code, configuration, framework behavior, tests, and runtime evidence where available.
- Do not use this mode for broad hunting, only for validation of candidates.

Source/license:
- Upstream source is Trail of Bits' fp-check skill.
- Trail of Bits skills are CC-BY-SA-4.0. This row is concise bridge text only. Preserve attribution and ShareAlike obligations if importing the full upstream skill body separately.
$skill$,
    'https://github.com/trailofbits/skills/blob/main/plugins/fp-check/skills/fp-check/SKILL.md',
    'CC-BY-SA-4.0',
    'References Trail of Bits skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'trail-of-bits-fp-check');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'trail-of-bits-insecure-defaults',
    'Trail of Bits insecure defaults',
    'Optional external Trail of Bits skill reference for fail-open defaults, hardcoded secrets, weak auth, and permissive production configuration.',
    $skill$
Use this optional external skill reference when a scan should review configuration and environment-variable handling for production fail-open behavior.

Focus:
- Find defaults that let an application run insecurely when secrets, keys, URLs, auth toggles, or policy settings are missing.
- Distinguish fail-open behavior from fail-secure crashes and explicit local-development fixtures.
- Review application config, Docker, Compose, Helm, Terraform, Kubernetes, deployment manifests, and CI variables.
- Report exploitable production paths, not examples, tests, samples, or documentation snippets.

Source/license:
- Upstream source is Trail of Bits' insecure-defaults skill.
- Trail of Bits skills are CC-BY-SA-4.0. This row is concise bridge text only. Preserve attribution and ShareAlike obligations if importing the full upstream skill body separately.
$skill$,
    'https://github.com/trailofbits/skills/blob/main/plugins/insecure-defaults/skills/insecure-defaults/SKILL.md',
    'CC-BY-SA-4.0',
    'References Trail of Bits skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'trail-of-bits-insecure-defaults');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'trail-of-bits-semgrep-rule-creator',
    'Trail of Bits Semgrep rule creator',
    'Optional external Trail of Bits skill reference for creating custom Semgrep security rules and taint analyses.',
    $skill$
Use this optional external skill reference when a scan should produce or improve custom static-analysis detections.

Focus:
- Translate a concrete vulnerability pattern into a tested Semgrep rule.
- Use taint mode for source-to-sink data-flow bugs and structural patterns for API misuse or insecure configuration.
- Create positive and negative test cases that prove the rule catches real variants without broad false positives.
- Treat generated rules as detection aids that still require manual validation before reporting findings.

Source/license:
- Upstream source is Trail of Bits' semgrep-rule-creator skill.
- Trail of Bits skills are CC-BY-SA-4.0. This row is concise bridge text only. Preserve attribution and ShareAlike obligations if importing the full upstream skill body separately.
$skill$,
    'https://github.com/trailofbits/skills/blob/main/plugins/semgrep-rule-creator/skills/semgrep-rule-creator/SKILL.md',
    'CC-BY-SA-4.0',
    'References Trail of Bits skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'trail-of-bits-semgrep-rule-creator');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'trail-of-bits-fuzzing-harness-writing',
    'Trail of Bits fuzzing harness writing',
    'Optional external Trail of Bits skill reference for designing effective fuzzing harnesses across languages and targets.',
    $skill$
Use this optional external skill reference when a scan should reason about or propose fuzzing harnesses.

Focus:
- Identify high-value parsers, decoders, protocol handlers, state machines, importers, and boundary APIs.
- Design deterministic harnesses that turn raw fuzzer input into meaningful calls into the system under test.
- Avoid harnesses that swallow bugs, skip important state, rely on network or time, or only exercise shallow parsing.
- Use fuzzing to validate concrete vulnerability hypotheses or improve coverage of risky code.

Source/license:
- Upstream source is Trail of Bits' harness-writing skill.
- Trail of Bits skills are CC-BY-SA-4.0. This row is concise bridge text only. Preserve attribution and ShareAlike obligations if importing the full upstream skill body separately.
$skill$,
    'https://github.com/trailofbits/skills/blob/main/plugins/testing-handbook-skills/skills/harness-writing/SKILL.md',
    'CC-BY-SA-4.0',
    'References Trail of Bits skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'trail-of-bits-fuzzing-harness-writing');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'trail-of-bits-libfuzzer',
    'Trail of Bits libFuzzer',
    'Optional external Trail of Bits skill reference for LLVM libFuzzer setup and C/C++ coverage-guided fuzzing.',
    $skill$
Use this optional external skill reference when a scan targets C or C++ code that can be compiled with Clang for coverage-guided fuzzing.

Focus:
- Recommend libFuzzer for quick in-process fuzzing of parsers, codecs, and library APIs.
- Identify compiler, sanitizer, corpus, dictionary, timeout, reproducibility, and crash-minimization considerations.
- Prefer harnesses that are compatible with AFL++ migration when larger fuzzing campaigns are needed.
- Treat fuzzing output as leads that still require root-cause and exploitability analysis.

Source/license:
- Upstream source is Trail of Bits' libFuzzer skill.
- Trail of Bits skills are CC-BY-SA-4.0. This row is concise bridge text only. Preserve attribution and ShareAlike obligations if importing the full upstream skill body separately.
$skill$,
    'https://github.com/trailofbits/skills/blob/main/plugins/testing-handbook-skills/skills/libfuzzer/SKILL.md',
    'CC-BY-SA-4.0',
    'References Trail of Bits skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'trail-of-bits-libfuzzer');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'trail-of-bits-yara-rule-authoring',
    'Trail of Bits YARA rule authoring',
    'Optional external Trail of Bits skill reference for malware-detection and threat-hunting YARA-X rule authoring.',
    $skill$
Use this optional external skill reference when a scan should produce or review YARA detection logic.

Focus:
- Target specific malware families, behaviors, file formats, or indicators instead of broad categories.
- Choose strings and atoms that balance precision, performance, and false-positive resistance.
- Order cheap file checks before expensive module calls or broad string sets.
- Include metadata and validation guidance so future researchers can understand and maintain the rule.

Source/license:
- Upstream source is Trail of Bits' yara-rule-authoring skill.
- Trail of Bits skills are CC-BY-SA-4.0. This row is concise bridge text only. Preserve attribution and ShareAlike obligations if importing the full upstream skill body separately.
$skill$,
    'https://github.com/trailofbits/skills/blob/main/plugins/yara-authoring/skills/yara-rule-authoring/SKILL.md',
    'CC-BY-SA-4.0',
    'References Trail of Bits skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'trail-of-bits-yara-rule-authoring');

INSERT INTO public.agent_skills (slug, name, description, content, source_url, license_spdx, attribution)
SELECT
    'trail-of-bits-zeroize-audit',
    'Trail of Bits zeroize audit',
    'Optional external Trail of Bits skill reference for missing or optimized-away secret zeroization in source code.',
    $skill$
Use this optional external skill reference when a scan reviews code that handles keys, passwords, tokens, seeds, or other sensitive material.

Focus:
- Trace secret copies across stack, heap, registers, structs, buffers, serialization, logs, and error paths.
- Identify missing cleanup or cleanup removed by compiler optimizations.
- Prefer evidence from control flow, compiler IR, assembly, or sanitizer-style observations when available.
- Report only cases where sensitive lifetime creates realistic disclosure risk or violates a security invariant.

Source/license:
- Upstream source is Trail of Bits' zeroize-audit skill.
- Trail of Bits skills are CC-BY-SA-4.0. This row is concise bridge text only. Preserve attribution and ShareAlike obligations if importing the full upstream skill body separately.
$skill$,
    'https://github.com/trailofbits/skills/blob/main/plugins/zeroize-audit/skills/zeroize-audit/SKILL.md',
    'CC-BY-SA-4.0',
    'References Trail of Bits skills metadata, concise bridge text only.'
WHERE NOT EXISTS (SELECT 1 FROM public.agent_skills WHERE slug = 'trail-of-bits-zeroize-audit');
