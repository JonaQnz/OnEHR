import { Router } from 'express';
import { getConfig, getSafeConfig, saveConfig } from '../services/configService';
import { requirePermission } from '../middleware/auth';

const router = Router();

router.get('/', requirePermission('system.configure'), (req, res) => {
  try {
    res.json(getSafeConfig());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// A single, safe field out of the full config (which sits behind
// system.configure) - any form.design tool that lets an author test against
// real patient data (widget preview, FormBuilder's Preview tab, ...) needs
// to know the operator's configured "always test against this patient"
// EHR-ID without getting the rest of AppConfig (secrets included).
router.get('/preview-defaults', requirePermission('form.design'), (_req, res) => {
  res.json({ defaultEhrId: getConfig().defaultEhrId || '' });
});

// Same pattern as preview-defaults above, but for the runtime (form.execute)
// audience instead of the design-time one: LiveForm.tsx's own autosave
// falls back to these when a form doesn't set its own
// settings.runtime.autosaveEnabled/autosaveDebounceMs.
router.get('/runtime-defaults', requirePermission('form.execute'), (_req, res) => {
  const config = getConfig();
  res.json({ autosaveEnabledByDefault: config.autosaveEnabledByDefault ?? true, autosaveDebounceMsDefault: config.autosaveDebounceMsDefault ?? 2500 });
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
