import { Router } from 'express';
import { requirePermission } from '../middleware/auth';
import { asyncHandler, HttpError } from '../middleware/errorHandler';
import { createLocalUser, listUsers, resetPassword, revokeUserSessions, setUserStatus, updateUser, UserServiceError } from '../services/userService';

const router = Router();
router.use(requirePermission('user.manage'));
function body(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Payload must be an object'); return value as Record<string, unknown>; }
function roles(value: unknown): ('USER' | 'ADMIN')[] | undefined { if (value === undefined) return undefined; if (!Array.isArray(value) || value.some((role) => role !== 'USER' && role !== 'ADMIN')) throw new HttpError(400, 'roles must contain USER or ADMIN'); return value as ('USER' | 'ADMIN')[]; }
function serviceError(error: unknown): never { if (error instanceof UserServiceError) throw new HttpError(error.status, error.message); throw error; }
router.get('/users', asyncHandler(async (_req, res) => res.json({ users: await listUsers() })));
router.post('/users', asyncHandler(async (req, res) => { const input = body(req.body); try { const user = await createLocalUser({ username: typeof input.username === 'string' ? input.username : '', password: typeof input.password === 'string' ? input.password : '', ...(typeof input.displayName === 'string' ? { displayName: input.displayName } : {}), ...(typeof input.email === 'string' ? { email: input.email } : {}), roles: roles(input.roles) }, req.principal!.userId); res.status(201).json({ user }); } catch (error) { serviceError(error); } }));
router.patch('/users/:id', asyncHandler(async (req, res) => { const input = body(req.body); try { const user = await updateUser(String(req.params.id), { ...(typeof input.displayName === 'string' ? { displayName: input.displayName } : {}), ...(typeof input.email === 'string' ? { email: input.email } : {}), ...(input.roles !== undefined ? { roles: roles(input.roles) } : {}) }, req.principal!.userId); res.json({ user }); } catch (error) { serviceError(error); } }));
router.post('/users/:id/activate', asyncHandler(async (req, res) => { try { res.json({ user: await setUserStatus(String(req.params.id), true, req.principal!.userId) }); } catch (error) { serviceError(error); } }));
router.post('/users/:id/deactivate', asyncHandler(async (req, res) => { try { res.json({ user: await setUserStatus(String(req.params.id), false, req.principal!.userId) }); } catch (error) { serviceError(error); } }));
router.post('/users/:id/reset-password', asyncHandler(async (req, res) => { const input = body(req.body); try { await resetPassword(String(req.params.id), typeof input.password === 'string' ? input.password : '', req.principal!.userId); res.status(204).end(); } catch (error) { serviceError(error); } }));
router.post('/users/:id/revoke-sessions', asyncHandler(async (req, res) => { await revokeUserSessions(String(req.params.id), req.principal!.userId); res.status(204).end(); }));
export default router;
