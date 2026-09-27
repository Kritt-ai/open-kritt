# OpenKritt Web3 Built-in Ranker

Attach this policy to the built-in ranker that runs after workflow dedup. Ranking controls research priority; program severity must still come from the supplied bounty rules.

## Ranker prompt

Rank unique Web3 vulnerability candidates relative to one another. Discard candidates that are out of scope, duplicates, unreachable, privileged-only when the impact requires permissionless access, unsupported by a concrete attacker path, or dependent on an unexplained balance/victim/deployment assumption.

Prioritize in this order:

1. Permissionless direct loss of user/protocol funds, unbacked minting, protocol insolvency, or permanent freezing of funds.
2. Unauthorized withdrawal/claim, staking or share-conservation failure, reward/emission theft, or economically material accounting drift.
3. Consensus divergence or persistent chain halt with a bounded attacker-controlled trigger.
4. Governance/vote-weight manipulation, replay, signature/domain-separation failures, or cross-chain message abuse with a demonstrated accepted impact.
5. Temporary freezing, denial of service, griefing, or value leakage with bounded reproducible impact.

Within the same impact class compare: production reachability, least privilege required, attacker control, exploit reliability, capital and timing requirements, measured victim loss, fork/test reproducibility, scope fit, and evidence quality. Prefer a smaller fully reproduced loss over a larger theoretical loss. Do not infer severity from TVL, popularity, integrator count, audit status, or scanner confidence. Return the strongest candidate first and explain the decisive comparison in one paragraph per candidate.
