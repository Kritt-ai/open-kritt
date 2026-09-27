# OpenKritt Web3 v2.5 focused workflow

This pack adds one program-aligned workflow for Cronos-family bounty research:

- `Cronos Fork-Differential Fund-Loss Hunt — Focused v2.5`

It is intentionally narrower than the v2.4 broad workflows. It keeps only
permissionless fund-loss and cryptographic-impact paths, requires a concrete
victim and attacker capture mechanism, distinguishes fork-local code from
upstream-only behavior, and treats missing runtime evidence as a visible
verification gap instead of silently proving safety.

Recommended run matrix:

1. Run each in-scope repository as the primary target at a pinned commit.
2. Attach the other in-scope repositories as pinned dependencies.
3. Use a diverse model for mapping and hypothesis generation.
4. Override depth 4 with an independent verifier model.
5. Use a local devnet or pinned local fork only; never send public-chain transactions.
