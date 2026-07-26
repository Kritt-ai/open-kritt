import { Router } from 'express';
import { prisma } from '../db.js';
import { validateAgentSkill } from '../lib/validation.js';
import { serializeAgentSkill } from '../lib/serialize.js';
import { configuredAgentSkillIds } from '../lib/repo.js';
import { lockAgentSkillForMutation } from '../lib/agentSkillLocks.js';

const router = Router();

export async function countAgentSkillScanUsage(tx, agentSkillId) {
  const scans = await tx.scan.findMany({
    select: { agentSkillIds: true, configuration: true },
  });
  const id = agentSkillId.toString();
  return scans.filter((scan) => configuredAgentSkillIds(scan).includes(id)).length;
}

export async function agentSkillMutationState(tx, id) {
  await lockAgentSkillForMutation(tx, id);
  const existing = await tx.agentSkill.findUnique({ where: { id } });
  if (!existing) return { kind: 'not-found' };
  const scanCount = await countAgentSkillScanUsage(tx, id);
  if (scanCount > 0) return { kind: 'in-use', scanCount };
  return { kind: 'available', existing };
}

// GET /api/agent-skills
router.get('/', async (req, res, next) => {
  try {
    const list = await prisma.agentSkill.findMany({ orderBy: { insertedAt: 'asc' } });
    res.json(list.map(serializeAgentSkill));
  } catch (e) {
    next(e);
  }
});

// GET /api/agent-skills/:id
router.get('/:id', async (req, res, next) => {
  try {
    const skill = await prisma.agentSkill.findUnique({ where: { id: BigInt(req.params.id) } });
    if (!skill) return res.status(404).json({ error: 'Agent skill not found.' });
    res.json(serializeAgentSkill(skill));
  } catch (e) {
    next(e);
  }
});

// POST /api/agent-skills
router.post('/', async (req, res, next) => {
  try {
    const valid = validateAgentSkill(req.body);
    const created = await prisma.agentSkill.create({ data: valid });
    res.status(201).json(serializeAgentSkill(created));
  } catch (e) {
    next(e);
  }
});

// PUT /api/agent-skills/:id
router.put('/:id', async (req, res, next) => {
  try {
    const id = BigInt(req.params.id);
    const valid = validateAgentSkill(req.body);
    const result = await prisma.$transaction(async (tx) => {
      const state = await agentSkillMutationState(tx, id);
      if (state.kind !== 'available') return state;
      const agentSkill = await tx.agentSkill.update({ where: { id }, data: valid });
      return { kind: 'updated', agentSkill };
    });
    if (result.kind === 'not-found') return res.status(404).json({ error: 'Agent skill not found.' });
    if (result.kind === 'in-use') {
      return res.status(409).json({
        error: `Cannot edit: ${result.scanCount} scan(s) use this agent skill. Duplicate it to make changes safely.`,
      });
    }
    res.json(serializeAgentSkill(result.agentSkill));
  } catch (e) {
    next(e);
  }
});

// DELETE /api/agent-skills/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const id = BigInt(req.params.id);
    const result = await prisma.$transaction(async (tx) => {
      const state = await agentSkillMutationState(tx, id);
      if (state.kind !== 'available') return state;
      await tx.agentSkill.delete({ where: { id } });
      return { kind: 'deleted' };
    });
    if (result.kind === 'not-found') return res.status(404).json({ error: 'Agent skill not found.' });
    if (result.kind === 'in-use') {
      return res.status(409).json({ error: `Cannot delete: ${result.scanCount} scan(s) use this agent skill.` });
    }
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
