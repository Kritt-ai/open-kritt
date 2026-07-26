import { Router } from 'express';
import { prisma } from '../db.js';
import { validatePostScript } from '../lib/validation.js';
import { serializePostScript } from '../lib/serialize.js';
import { configuredPostScriptIds } from '../lib/repo.js';
import { lockPostScriptForMutation } from '../lib/postScriptLocks.js';

const router = Router();

export async function countPostScriptScanUsage(tx, postScriptId) {
  const scans = await tx.scan.findMany({
    select: { postScriptId: true, configuration: true },
  });
  const id = postScriptId.toString();
  return scans.filter((scan) => configuredPostScriptIds(scan).includes(id)).length;
}

export async function postScriptMutationState(tx, id) {
  await lockPostScriptForMutation(tx, id);
  const existing = await tx.postScript.findUnique({ where: { id } });
  if (!existing) return { kind: 'not-found' };
  const scanCount = await countPostScriptScanUsage(tx, id);
  if (scanCount > 0) return { kind: 'in-use', scanCount };
  return { kind: 'available', existing };
}

// Derive a short human description from content when none is provided.
function deriveDescription(content) {
  return (content || '')
    .replace(/\{\{\s*|\s*\}\}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// GET /api/post-scripts
router.get('/', async (req, res, next) => {
  try {
    const list = await prisma.postScript.findMany({ orderBy: { insertedAt: 'desc' } });
    res.json(list.map(serializePostScript));
  } catch (e) {
    next(e);
  }
});

// GET /api/post-scripts/:id
router.get('/:id', async (req, res, next) => {
  try {
    const ps = await prisma.postScript.findUnique({ where: { id: BigInt(req.params.id) } });
    if (!ps) return res.status(404).json({ error: 'Post-script not found.' });
    res.json(serializePostScript(ps));
  } catch (e) {
    next(e);
  }
});

// POST /api/post-scripts
router.post('/', async (req, res, next) => {
  try {
    const valid = validatePostScript(req.body);
    const created = await prisma.postScript.create({
      data: {
        name: valid.name,
        content: valid.content,
        outputFormat: JSON.stringify(valid.outputFormat),
        description: valid.description || deriveDescription(valid.content),
      },
    });
    res.status(201).json(serializePostScript(created));
  } catch (e) {
    next(e);
  }
});

// PUT /api/post-scripts/:id
router.put('/:id', async (req, res, next) => {
  try {
    const id = BigInt(req.params.id);
    const valid = validatePostScript(req.body);
    const result = await prisma.$transaction(async (tx) => {
      const state = await postScriptMutationState(tx, id);
      if (state.kind !== 'available') return state;
      const postScript = await tx.postScript.update({
        where: { id },
        data: {
          name: valid.name,
          content: valid.content,
          outputFormat: JSON.stringify(valid.outputFormat),
          description: valid.description || deriveDescription(valid.content),
        },
      });
      return { kind: 'updated', postScript };
    });
    if (result.kind === 'not-found') return res.status(404).json({ error: 'Post-script not found.' });
    if (result.kind === 'in-use') {
      return res.status(409).json({
        error: `Cannot edit: ${result.scanCount} scan(s) use this post-script. Duplicate it to make changes safely.`,
      });
    }
    res.json(serializePostScript(result.postScript));
  } catch (e) {
    next(e);
  }
});

// DELETE /api/post-scripts/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const id = BigInt(req.params.id);
    const result = await prisma.$transaction(async (tx) => {
      const state = await postScriptMutationState(tx, id);
      if (state.kind !== 'available') return state;
      await tx.postScript.delete({ where: { id } });
      return { kind: 'deleted' };
    });
    if (result.kind === 'not-found') return res.status(404).json({ error: 'Post-script not found.' });
    if (result.kind === 'in-use') {
      return res.status(409).json({ error: `Cannot delete: ${result.scanCount} scan(s) use this post-script.` });
    }
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
