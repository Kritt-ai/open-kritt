import { Router } from 'express';
import { prisma } from '../db.js';
import { ensureDefaultSeverityRankers, isDefaultSeverityRankerName } from '../lib/defaultSeverityRankers.js';
import { validateSeverityRanker } from '../lib/validation.js';
import { serializeSeverityRanker } from '../lib/serialize.js';

const router = Router();

// GET /api/severity-rankers
router.get('/', async (req, res, next) => {
  try {
    await ensureDefaultSeverityRankers();
    const list = await prisma.severityRanker.findMany({ orderBy: { insertedAt: 'asc' } });
    res.json(
      list.map((ranker) => serializeSeverityRanker(ranker, { isDefault: isDefaultSeverityRankerName(ranker.name) }))
    );
  } catch (e) {
    next(e);
  }
});

// GET /api/severity-rankers/:id
router.get('/:id', async (req, res, next) => {
  try {
    const ranker = await prisma.severityRanker.findUnique({ where: { id: BigInt(req.params.id) } });
    if (!ranker) return res.status(404).json({ error: 'Severity ranker not found.' });
    res.json(serializeSeverityRanker(ranker, { isDefault: isDefaultSeverityRankerName(ranker.name) }));
  } catch (e) {
    next(e);
  }
});

// POST /api/severity-rankers
router.post('/', async (req, res, next) => {
  try {
    const valid = validateSeverityRanker(req.body);
    const created = await prisma.severityRanker.create({ data: valid });
    res.status(201).json(serializeSeverityRanker(created, { isDefault: isDefaultSeverityRankerName(created.name) }));
  } catch (e) {
    next(e);
  }
});

// PUT /api/severity-rankers/:id
router.put('/:id', async (req, res, next) => {
  try {
    const id = BigInt(req.params.id);
    const existing = await prisma.severityRanker.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Severity ranker not found.' });
    const valid = validateSeverityRanker(req.body);
    const updated = await prisma.severityRanker.update({ where: { id }, data: valid });
    res.json(serializeSeverityRanker(updated, { isDefault: isDefaultSeverityRankerName(updated.name) }));
  } catch (e) {
    next(e);
  }
});

// DELETE /api/severity-rankers/:id
// Scans persist the concatenated ruleset string (not ranker ids), so deleting a
// ranker never breaks an existing scan — no in-use guard needed.
router.delete('/:id', async (req, res, next) => {
  try {
    const id = BigInt(req.params.id);
    const existing = await prisma.severityRanker.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Severity ranker not found.' });
    await prisma.severityRanker.delete({ where: { id } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
