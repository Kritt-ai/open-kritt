import { Router } from 'express';
import { listLocalRepos } from '../lib/localRepos.js';

const router = Router();

// GET /api/local-repos — the repositories available under LOCAL_REPOS_PATH.
router.get('/', (req, res, next) => {
  try {
    res.json(listLocalRepos());
  } catch (e) {
    next(e);
  }
});

export default router;
