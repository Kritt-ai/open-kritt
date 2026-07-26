import { prisma } from '../db.js';

export const DEFAULT_SEVERITY_RANKERS = [
  {
    name: 'Blockchain security triage',
    description: 'A conservative production-impact ranker suitable for a first scan.',
    content: `Rank only findings with a concrete, externally reachable production trigger.

- Critical: consensus or integrity corruption, network-wide persistent outage, or unauthorized asset creation, destruction, or theft.
- High: realistic remote input causing a prolonged service outage, consensus safety/liveness failure, authentication bypass, or substantial asset impact.
- Medium: bounded availability, authorization, or integrity impact with meaningful prerequisites or limited blast radius.
- Low: defense-in-depth issues with a concrete but minor production impact.
- Informational: hardening opportunities without demonstrated security impact.

Prefer end-to-end evidence, reachable default or supplied configuration, and reproducible triggers. Demote theoretical, test-only, privileged-local, brute-force, race-dependent, non-default, and unverified findings. Rank likely false positives last.`,
  },
];

export const DEFAULT_SEVERITY_RANKER_NAMES = DEFAULT_SEVERITY_RANKERS.map((ranker) => ranker.name);

export function isDefaultSeverityRankerName(name) {
  return DEFAULT_SEVERITY_RANKER_NAMES.includes(name);
}

export async function ensureDefaultSeverityRankers(client = prisma) {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('open-kritt-default-severity-rankers'))`;

    const installed = [];
    for (const ranker of DEFAULT_SEVERITY_RANKERS) {
      const existing = await tx.severityRanker.findFirst({
        where: { name: ranker.name },
        orderBy: { insertedAt: 'asc' },
        select: { id: true },
      });
      if (existing) continue;
      await tx.severityRanker.create({ data: ranker });
      installed.push(ranker.name);
    }
    return installed;
  });
}
