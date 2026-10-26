import { Router } from 'express';
import type { FormsApiClient } from '../formsApiClient';

/** Thin proxy so the frontend never needs the Forms-API session cookie
 * itself - list existing patients to target, or create a disposable test
 * one. Mirrors GET/POST /api/patients on the Forms API 1:1. */
export function createPatientRoutes(api: FormsApiClient) {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      res.json(await api.get('/api/patients'));
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/', async (req, res) => {
    try {
      res.json(await api.post('/api/patients', req.body));
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
