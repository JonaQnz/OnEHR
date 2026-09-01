import { Router } from 'express';
import { asyncHandler, HttpError } from '../middleware/errorHandler';
import { createPatient, getPatientCreationConfiguration, listPatients, getPatient, syncPatientsFromEhrbase } from '../services/patientService';
import { requirePermission } from '../middleware/auth';

const router = Router();

router.get('/', requirePermission('patient.search'), asyncHandler(async (_req, res) => {
  const patients = await listPatients();
  res.json(patients);
}));

router.post('/sync', requirePermission('patient.search'), asyncHandler(async (_req, res) => {
  const synchronized = await syncPatientsFromEhrbase(true);
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

// Lets a caller (the Form Builder UI, an agent) check up front whether
// patient creation is routed through EHRbase directly or the FHIR CDR
// connector, and - in FHIR mode - which Person Form Section's values it
// needs, before attempting create_patient. See patientService's own doc
// comment for why this fails closed instead of silently falling back.
router.get('/creation-configuration', requirePermission('patient.search'), (_req, res) => {
  res.json(getPatientCreationConfiguration());
});

router.post('/', requirePermission('patient.search'), asyncHandler(async (req, res) => {
  const { patientId, firstName, lastName, birthDate, gender, personFormValues } = req.body;
  if (!patientId || !firstName || !lastName) {
    throw new HttpError(400, 'Missing required fields: patientId, firstName, lastName');
  }

  const patient = await createPatient({ patientId, firstName, lastName, birthDate, gender, ...(personFormValues ? { personFormValues } : {}) });
  res.status(201).json({ message: 'Patient created', patient });
}));

export default router;
