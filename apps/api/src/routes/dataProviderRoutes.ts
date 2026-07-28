import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { dataProviderRegistry } from '../services/dataProviderRegistry';

const router = Router();
router.use(requireAuth);
router.get('/', (_req, res) => res.json(dataProviderRegistry.list()));

export default router;
