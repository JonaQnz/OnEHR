import axios from 'axios';
import prisma from '../db/prisma';
import { getConfig } from './configService';
import { getValidToken } from './authService';

export interface CreatePatientInput {
  patientId: string;
  patientNamespace?: string;
  firstName: string;
  lastName: string;
  birthDate?: string;
  gender?: string;
}

export async function createPatient(input: CreatePatientInput) {
  const config = getConfig();
  const namespace = input.patientNamespace || config.ehrbaseSubjectNamespace || 'default';
  
  // 1. Check if patient already exists locally
  const existing = await prisma.patient.findUnique({
    where: {
      patientNamespace_patientId: {
        patientNamespace: namespace,
        patientId: input.patientId
      }
    }
  });

  if (existing) {
    throw new Error(`Patient with ID ${input.patientId} already exists in namespace ${namespace}`);
  }

  // 2. Create EHR in EHRbase
  let ehrId: string;
  
  try {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };
    let auth: any = undefined;

    if (config.authMode === 'keycloak') {
      const token = await getValidToken();
      headers['Authorization'] = `Bearer ${token}`;
    } else {
      auth = {
        username: config.ehrbaseUser!,
        password: config.ehrbasePass!
      };
    }

    const ehrbaseUrl = config.ehrbaseUrl!.replace(/\/$/, '');
    
    // Check if EHR already exists
    try {
      const getResponse = await axios.get(`${ehrbaseUrl}/ehr`, {
        headers,
        auth,
        params: { subject_id: input.patientId, subject_namespace: namespace }
      });
      ehrId = getResponse.data.ehr_id.value;
    } catch (e: any) {
      if (e.response?.status === 404) {
        // Create new EHR
        const ehrStatus = {
          _type: "EHR_STATUS",
          archetype_node_id: "openEHR-EHR-EHR_STATUS.generic.v1",
          name: { value: "EHR Status" },
          subject: {
            external_ref: {
              id: { _type: "GENERIC_ID", value: input.patientId, scheme: "id_scheme" },
              namespace: namespace,
              type: "PERSON"
            }
          },
          is_queryable: true,
          is_modifiable: true
        };

        const postResponse = await axios.post(`${ehrbaseUrl}/ehr`, ehrStatus, { headers, auth });
        ehrId = postResponse.data.ehr_id?.value || postResponse.data.ehr_id;
      } else {
        throw e;
      }
    }
  } catch (error: any) {
    console.error('Failed to create EHR:', error.response?.data || error.message);
    throw new Error('Failed to create EHR in EHRbase');
  }

  if (!ehrId) {
    throw new Error('Could not retrieve ehrId from EHRbase');
  }

  // 3. Save to Local DB
  const patient = await prisma.patient.create({
    data: {
      patientId: input.patientId,
      patientNamespace: namespace,
      firstName: input.firstName,
      lastName: input.lastName,
      birthDate: input.birthDate,
      gender: input.gender,
      ehrId: ehrId
    }
  });

  return patient;
}

export async function listPatients() {
  return prisma.patient.findMany({
    orderBy: { createdAt: 'desc' }
  });
}

export async function getPatient(id: string) {
  return prisma.patient.findUnique({
    where: { id }
  });
}
