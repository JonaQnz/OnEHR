import prisma from '../db/prisma';

/**
 * Persistent capture of every outbound write Forms sends to an external
 * clinical data store (the FHIR CDR or EHRbase), so a real payload can
 * later be downloaded and turned into a Bruno request by hand - see
 * IntegrationCallLog in schema.prisma for the full rationale. Every writer
 * call site (ehrbaseDataProvider.ts, fhirCdrService.ts,
 * ehrbaseConnectionPlugins.ts, patientService.ts) calls logIntegrationCall
 * fire-and-forget on both the success and failure path of its own request -
 * this file only owns persistence/retrieval, never the calls themselves.
 */

export type IntegrationProtocol = 'fhir' | 'openehr';

export interface LogIntegrationCallInput {
  protocol: IntegrationProtocol;
  resourceType: string;
  operation: string;
  method: string;
  url: string;
  requestBody?: unknown;
  responseBody?: unknown;
  statusCode?: number;
  success: boolean;
  errorMessage?: string;
  ehrId?: string;
  patientId?: string;
  fhirPatientId?: string;
}

// Deliberately never throws - a logging failure must never affect the real
// call it's describing. Every writer call site fires this and moves on.
export async function logIntegrationCall(input: LogIntegrationCallInput): Promise<void> {
  try {
    await prisma.integrationCallLog.create({
      data: {
        protocol: input.protocol,
        resourceType: input.resourceType,
        operation: input.operation,
        method: input.method,
        url: input.url,
        requestBody: (input.requestBody ?? undefined) as any,
        responseBody: (input.responseBody ?? undefined) as any,
        statusCode: input.statusCode,
        success: input.success,
        errorMessage: input.errorMessage,
        ehrId: input.ehrId,
        patientId: input.patientId,
        fhirPatientId: input.fhirPatientId,
      },
    });
  } catch (error) {
    console.error('[IntegrationCallLog] Failed to persist call log (the call itself was unaffected):', error instanceof Error ? error.message : error);
  }
}

export interface ListIntegrationCallLogsOptions {
  protocol?: IntegrationProtocol;
  resourceType?: string;
  success?: boolean;
  // OR'd together when both given - a patient's calls can carry only one of
  // the two (e.g. the very call that creates the EHR only has patientId;
  // everything after it has both), so requiring both would silently miss
  // rows the Patient Detail debug tab needs to show.
  ehrId?: string;
  patientId?: string;
  limit?: number;
  offset?: number;
}

// Lightweight rows only (no request/response bodies) - use
// getIntegrationCallLog for the full payload of one entry.
export async function listIntegrationCallLogs(options: ListIntegrationCallLogsOptions = {}) {
  const { protocol, resourceType, success, ehrId, patientId, limit = 50, offset = 0 } = options;
  const identifierFilter = ehrId && patientId
    ? { OR: [{ ehrId }, { patientId }] }
    : ehrId ? { ehrId } : patientId ? { patientId } : {};
  return prisma.integrationCallLog.findMany({
    where: {
      ...(protocol ? { protocol } : {}),
      ...(resourceType ? { resourceType } : {}),
      ...(success !== undefined ? { success } : {}),
      ...identifierFilter,
    },
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(limit, 200)),
    skip: Math.max(0, offset),
    select: {
      id: true, protocol: true, resourceType: true, operation: true, method: true, url: true,
      statusCode: true, success: true, errorMessage: true, ehrId: true, patientId: true, fhirPatientId: true, createdAt: true,
    },
  });
}

export async function getIntegrationCallLog(id: string) {
  return prisma.integrationCallLog.findUnique({ where: { id } });
}

export interface ExportIntegrationCallLogsOptions {
  protocol?: IntegrationProtocol;
  resourceType?: string;
  success?: boolean;
  ehrId?: string;
  patientId?: string;
}

// Full records (request/response bodies included), oldest first so a
// batch export reads like the case's own build-up - used only for the
// Bruno export (bounded, deliberate batch download), never the paginated
// UI list, so it skips listIntegrationCallLogs's 200-row cap.
export async function listIntegrationCallLogsForExport(options: ExportIntegrationCallLogsOptions = {}) {
  const { protocol, resourceType, success, ehrId, patientId } = options;
  const identifierFilter = ehrId && patientId
    ? { OR: [{ ehrId }, { patientId }] }
    : ehrId ? { ehrId } : patientId ? { patientId } : {};
  return prisma.integrationCallLog.findMany({
    where: {
      ...(protocol ? { protocol } : {}),
      ...(resourceType ? { resourceType } : {}),
      ...(success !== undefined ? { success } : {}),
      ...identifierFilter,
    },
    orderBy: { createdAt: 'asc' },
    take: 2000,
  });
}

export async function deleteIntegrationCallLog(id: string) {
  await prisma.integrationCallLog.delete({ where: { id } }).catch(() => undefined);
}
