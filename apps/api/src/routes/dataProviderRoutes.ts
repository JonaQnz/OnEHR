import { Router } from 'express';
import { requirePermission } from '../middleware/auth';
import { dataProviderRegistry } from '../services/dataProviderRegistry';

const router = Router();
router.use(requirePermission('composition.read'));
router.get('/', (_req, res) => res.json(dataProviderRegistry.list()));

export default router;
