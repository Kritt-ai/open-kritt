import { Router } from 'express';
import { prisma } from '../db.js';
import { serializeVulnerability } from '../lib/serialize.js';

const router = Router();

export function buildVulnerabilityPatch(body = {}) {
  const data = {};
  let appendComments;
  if ('interesting' in body) {
    const val = body.interesting;
    if (val === null) data.interesting = null;
    else if (val === 0 || val === 1 || val === '0' || val === '1') data.interesting = BigInt(Number(val));
    else return { error: { field: 'interesting', message: 'interesting must be 0, 1, or null.' } };
  }
  if ('comments' in body && 'appendComments' in body) {
    return { error: { field: 'comments', message: 'comments and appendComments are mutually exclusive.' } };
  }
  if ('comments' in body) {
    data.comments = body.comments === null || body.comments === '' ? null : String(body.comments);
  }
  if ('appendComments' in body) {
    if (typeof body.appendComments !== 'string' || !body.appendComments.trim()) {
      return { error: { field: 'appendComments', message: 'appendComments must be a non-empty string.' } };
    }
    if (Buffer.byteLength(body.appendComments, 'utf8') > 64 * 1024) {
      return { error: { field: 'appendComments', message: 'appendComments must not exceed 64 KiB.' } };
    }
    appendComments = body.appendComments;
  }
  if (Object.keys(data).length === 0 && appendComments === undefined) {
    return { error: { field: 'body', message: 'Provide interesting, comments, and/or appendComments.' } };
  }
  return { data, appendComments };
}

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
// appendComments: atomically append a non-empty marker once without overwriting concurrent comments.
router.patch('/:id', async (req, res, next) => {
  try {
    const id = BigInt(req.params.id);
    const existing = await prisma.vulnerability.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return res.status(404).json({ error: 'Vulnerability not found.' });

    const patch = buildVulnerabilityPatch(req.body || {});
    if (patch.error) {
      return res.status(422).json({ errors: [patch.error] });
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (patch.appendComments !== undefined) {
        await tx.$executeRaw`
          UPDATE "workflows"."vulnerabilities"
          SET
            "comments" = CASE
              WHEN "comments" IS NULL OR "comments" = '' THEN ${patch.appendComments}
              WHEN POSITION(${patch.appendComments} IN "comments") > 0 THEN "comments"
              ELSE "comments" || E'\n\n' || ${patch.appendComments}
            END,
            "updated_at" = NOW()
          WHERE "id" = ${id}
        `;
      }
      if (Object.keys(patch.data).length > 0) {
        return tx.vulnerability.update({
          where: { id },
          data: patch.data,
          select: { id: true, interesting: true, comments: true },
        });
      }
      return tx.vulnerability.findUnique({
        where: { id },
        select: { id: true, interesting: true, comments: true },
      });
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
