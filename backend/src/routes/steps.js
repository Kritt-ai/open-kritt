import { Router } from 'express';
import { prisma } from '../db.js';
import { serializeStep } from '../lib/serialize.js';

const router = Router();

// GET /api/steps — the steps library: every step across every workflow,
// annotated with which workflow it belongs to.
router.get('/', async (req, res, next) => {
  try {
    const [steps, workflows] = await Promise.all([
      prisma.step.findMany({ orderBy: [{ depth: 'asc' }, { id: 'asc' }] }),
      prisma.workflow.findMany({ select: { id: true, name: true, stepIds: true } }),
    ]);
    // Map each step id -> workflow name.
    const stepToWorkflow = new Map();
    for (const w of workflows) {
      for (const sid of w.stepIds || []) stepToWorkflow.set(sid.toString(), w.name);
    }
    res.json(
      steps.map((s) => ({
        ...serializeStep(s),
        keys: Object.keys(serializeStep(s).outputFormat),
        workflowName: stepToWorkflow.get(s.id.toString()) || null,
      }))
    );
  } catch (e) {
    next(e);
  }
});

export default router;
