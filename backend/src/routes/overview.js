import { Router } from 'express';
import { prisma } from '../db.js';
import { assembleScans } from '../lib/repo.js';

const router = Router();

export function summarizeCanonicalFindings(vulnerabilities) {
  let findingsCount = 0;
  let exploitableCount = 0;
  for (const vulnerability of vulnerabilities) {
    if (vulnerability.dedupeIsCanonical === false) continue;
    findingsCount += 1;
    const exploitable =
      vulnerability.jsonAnswer && typeof vulnerability.jsonAnswer === 'object'
        ? vulnerability.jsonAnswer.exploitable
        : null;
    if (exploitable === true || exploitable === 'true') exploitableCount += 1;
  }
  return { findingsCount, exploitableCount };
}

export function scanResearchKey(scan) {
  const configuration = scan?.configuration && typeof scan.configuration === 'object' ? scan.configuration : {};
  const identity = configuration.research_id || configuration.program || scan?.repoFull || scan?.id;
  const kind = configuration.benchmark_mode === true ? 'benchmark' : 'research';
  return `${identity}::${kind}`;
}

// GET /api/overview — KPIs + recent scans for the dashboard.
router.get('/', async (req, res, next) => {
  try {
    const activeStatuses = ['prewarming_cache', 'running', 'post_processing'];
    const [workflowCount, scanCount, runningCount, recentRaw, activeRaw] = await Promise.all([
      prisma.workflow.count(),
      prisma.scan.count(),
      prisma.scan.count({ where: { status: { in: activeStatuses } } }),
      prisma.scan.findMany({ orderBy: { insertedAt: 'desc' }, take: 100 }),
      prisma.scan.findFirst({ where: { status: { in: activeStatuses } }, orderBy: { insertedAt: 'desc' } }),
    ]);
    const requestedScanId = /^\d+$/.test(`${req.query.scanId || ''}`) ? BigInt(req.query.scanId) : null;
    const requestedRaw = requestedScanId ? recentRaw.find((scan) => scan.id === requestedScanId) : null;
    const focusRaw = requestedRaw || activeRaw || recentRaw[0] || null;
    const focusKey = focusRaw ? scanResearchKey(focusRaw) : null;
    const researchRaw = focusKey ? recentRaw.filter((scan) => scanResearchKey(scan) === focusKey) : [];
    const researchIds = researchRaw.map((scan) => scan.id);
    const focusVulns = researchIds.length
      ? await prisma.vulnerability.findMany({
          where: { scanId: { in: researchIds } },
          select: { jsonAnswer: true, dedupeIsCanonical: true },
        })
      : [];
    const { findingsCount, exploitableCount } = summarizeCanonicalFindings(focusVulns);
    const representatives = [];
    const seenResearch = new Set();
    for (const scan of recentRaw) {
      const key = scanResearchKey(scan);
      if (seenResearch.has(key)) continue;
      seenResearch.add(key);
      representatives.push(scan);
    }
    const [focusScans, researchScans, availableScans] = await Promise.all([
      focusRaw ? assembleScans([focusRaw]) : [],
      assembleScans(researchRaw),
      assembleScans(representatives),
    ]);

    res.json({
      workflowCount,
      scanCount,
      runningCount,
      findingsCount,
      exploitableCount,
      focusScan: focusScans[0] || null,
      recentScans: researchScans,
      availableScans,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
