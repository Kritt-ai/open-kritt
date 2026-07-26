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

// GET /api/overview — KPIs + recent scans for the dashboard.
router.get('/', async (req, res, next) => {
  try {
    const [workflowCount, scanCount, runningCount, recentRaw, allVulns] = await Promise.all([
      prisma.workflow.count(),
      prisma.scan.count(),
      prisma.scan.count({ where: { status: { in: ['prewarming_cache', 'running', 'post_processing'] } } }),
      prisma.scan.findMany({ orderBy: { insertedAt: 'desc' }, take: 5 }),
      prisma.vulnerability.findMany({ select: { jsonAnswer: true, dedupeIsCanonical: true } }),
    ]);
    const { findingsCount, exploitableCount } = summarizeCanonicalFindings(allVulns);

    res.json({
      workflowCount,
      scanCount,
      runningCount,
      findingsCount,
      exploitableCount,
      recentScans: await assembleScans(recentRaw),
    });
  } catch (e) {
    next(e);
  }
});

export default router;
