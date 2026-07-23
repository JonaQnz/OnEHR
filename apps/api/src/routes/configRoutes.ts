import { Router } from 'express';
import { getSafeConfig, saveConfig } from '../services/configService';

const router = Router();

router.get('/', (req, res) => {
  try {
    res.json(getSafeConfig());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', (req, res) => {
  try {
    saveConfig(req.body);
    res.json({ message: 'Configuration saved successfully', config: getSafeConfig() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
