import { validateAdaptiveDiscovery } from './validation.js';

export async function scanDiscoveryStatus(db, scan) {
  const configuration = validateAdaptiveDiscovery(scan.configuration);
  if (!configuration) return { enabled: false, frontier: null, paths: [] };
  // One snapshot prevents a frontier completion racing with its path records.
  const [frontier, paths] = await db.$transaction(
    async (tx) => [
      await tx.discoveryFrontier.findUnique({ where: { scanId: scan.id } }),
      await tx.discoveryPath.findMany({ where: { scanId: scan.id }, orderBy: { id: 'asc' } }),
    ],
    { isolationLevel: 'RepeatableRead' }
  );
  // Prisma bigint identifiers are decimal strings at the JSON boundary.
  return JSON.parse(
    JSON.stringify({ enabled: true, state_source: 'persisted', configuration, frontier, paths }, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )
  );
}
