import { Router } from 'express';
import { prisma } from '../db.js';
import { serializeVulnerability } from '../lib/serialize.js';

const router = Router();

// GET /api/vulnerabilities/:id — a single finding with its post-script output.
router.get('/:id', async (req, res, next) => {
  try {
    const id = BigInt(req.params.id);
    const v = await prisma.vulnerability.findUnique({ where: { id } });
    if (!v) return res.status(404).json({ error: 'Vulnerability not found.' });
    const [enrichments, duplicates] = await Promise.all([
      prisma.vulnerabilityEnrichment.findMany({ where: { vulnerabilityId: id }, orderBy: [{ id: 'asc' }] }),
      prisma.vulnerability.findMany({
        where: { scanId: v.scanId, dedupeCanonicalId: id, dedupeIsCanonical: false },
        select: { id: true },
        orderBy: [{ id: 'asc' }],
      }),
    ]);
    res.json(
      serializeVulnerability(v, {
        enrichments,
        duplicateIds: duplicates.map((d) => d.id),
      })
    );
  } catch (e) {
    next(e);
  }
});

// PATCH /api/vulnerabilities/:id — user review: interesting flag and/or comments.
// interesting: 1 (interesting), 0 (not interesting), or null (unmarked).
router.patch('/:id', async (req, res, next) => {
  try {
    const id = BigInt(req.params.id);
    const existing = await prisma.vulnerability.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return res.status(404).json({ error: 'Vulnerability not found.' });

    const body = req.body || {};
    const data = {};
    if ('interesting' in body) {
      const val = body.interesting;
      if (val === null) data.interesting = null;
      else if (val === 0 || val === 1 || val === '0' || val === '1') data.interesting = BigInt(Number(val));
      else
        return res
          .status(422)
          .json({ errors: [{ field: 'interesting', message: 'interesting must be 0, 1, or null.' }] });
    }
    if ('comments' in body) {
      data.comments = body.comments === null || body.comments === '' ? null : String(body.comments);
    }
    if (Object.keys(data).length === 0) {
      return res.status(422).json({ errors: [{ field: 'body', message: 'Provide interesting and/or comments.' }] });
    }

    const updated = await prisma.vulnerability.update({
      where: { id },
      data,
      select: { id: true, interesting: true, comments: true },
    });
    res.json({
      id: updated.id.toString(),
      interesting:
        updated.interesting === null || updated.interesting === undefined ? null : Number(updated.interesting),
      comments: updated.comments ?? null,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
