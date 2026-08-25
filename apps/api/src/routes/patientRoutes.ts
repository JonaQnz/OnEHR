import { Router } from 'express';
import { asyncHandler, HttpError } from '../middleware/errorHandler';
import { createPatient, listPatients, getPatient, syncPatientsFromPersonCompositions } from '../services/patientService';
import { requirePermission } from '../middleware/auth';

const router = Router();

router.get('/', requirePermission('patient.search'), asyncHandler(async (_req, res) => {
  const patients = await listPatients();
  res.json(patients);
}));

router.post('/sync', requirePermission('patient.search'), asyncHandler(async (_req, res) => {
  const synchronized = await syncPatientsFromPersonCompositions(true);
  res.json({ synchronized, patients: await listPatients(false) });
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

import { executeAqlQuery } from '../services/aqlFunctionService';

router.get('/:id/compositions', requirePermission('patient.read'), asyncHandler(async (req, res) => {
  const id = requireNonEmptyString(req.params.id, 'id');
  const patient = await getPatient(id);
  if (!patient || !patient.ehrId) {
    res.json([]);
    return;
  }
  const query = "SELECT c/uid/value AS compositionUid, c/name/value AS compositionName, c/archetype_details/template_id/value AS templateId, c/context/start_time/value AS recordedAt, c/composer/name AS composer FROM EHR ehr[ehr_id/value = :ehrId] CONTAINS COMPOSITION c ORDER BY c/context/start_time/value DESC LIMIT 50";
  const rows = await executeAqlQuery(query, { ehrId: patient.ehrId });
  res.json(rows);
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
