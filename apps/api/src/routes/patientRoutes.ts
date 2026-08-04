import { Router } from 'express';
import { asyncHandler, HttpError } from '../middleware/errorHandler';
import { createPatient, listPatients, getPatient } from '../services/patientService';
import { requirePermission } from '../middleware/auth';

const router = Router();

router.get('/', requirePermission('patient.search'), asyncHandler(async (_req, res) => {
  const patients = await listPatients();
  res.json(patients);
}));

import { requireNonEmptyString } from '../validation/formValidation';

router.get('/:id', requirePermission('patient.read'), asyncHandler(async (req, res) => {
  const id = requireNonEmptyString(req.params.id, 'id');
  const patient = await getPatient(id);
  if (!patient) {
    throw new HttpError(404, 'Patient not found');
  }
  res.json(patient);
}));

router.post('/', requirePermission('patient.search'), asyncHandler(async (req, res) => {
  const { patientId, firstName, lastName, birthDate, gender } = req.body;
  if (!patientId || !firstName || !lastName) {
    throw new HttpError(400, 'Missing required fields: patientId, firstName, lastName');
  }

  const patient = await createPatient({ patientId, firstName, lastName, birthDate, gender });
  res.status(201).json({ message: 'Patient created', patient });
}));

export default router;
