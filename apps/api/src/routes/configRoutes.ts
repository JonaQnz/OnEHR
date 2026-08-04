import { Router } from 'express';
import { getSafeConfig, saveConfig } from '../services/configService';
import { requirePermission } from '../middleware/auth';

const router = Router();

router.get('/', requirePermission('system.configure'), (req, res) => {
  try {
    res.json(getSafeConfig());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', requirePermission('system.configure'), (req, res) => {
  try {
    saveConfig(req.body);
    res.json({ message: 'Configuration saved successfully', config: getSafeConfig() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
