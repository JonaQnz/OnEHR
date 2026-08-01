import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { createAqlFunction, createCodeFunction, deleteAqlFunction, deleteCodeFunction, listAqlFunctions, listCodeFunctions, updateAqlFunction, updateCodeFunction } from '../services/aqlFunctionService';

const router = Router();
router.use(requireAuth);

router.get('/aql', asyncHandler(async (_req, res) => res.json({ functions: await listAqlFunctions() })));
router.post('/aql', asyncHandler(async (req, res) => res.status(201).json(await createAqlFunction(req.body))));
router.put('/aql/:id', asyncHandler(async (req, res) => res.json(await updateAqlFunction(String(req.params.id), req.body))));
router.delete('/aql/:id', asyncHandler(async (req, res) => { await deleteAqlFunction(String(req.params.id)); res.status(204).end(); }));
router.get('/code', asyncHandler(async (_req, res) => res.json({ functions: await listCodeFunctions() })));
router.post('/code', asyncHandler(async (req, res) => res.status(201).json(await createCodeFunction(req.body))));
router.put('/code/:id', asyncHandler(async (req, res) => res.json(await updateCodeFunction(String(req.params.id), req.body))));
router.delete('/code/:id', asyncHandler(async (req, res) => { await deleteCodeFunction(String(req.params.id)); res.status(204).end(); }));

export default router;
