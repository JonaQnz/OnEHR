import archiver from 'archiver';
import type { Response } from 'express';
import type { IntegrationCallLog } from '@prisma/client';

/**
 * Packages captured IntegrationCallLog rows (see integrationCallLogService.ts)
 * as a Bruno (usebruno.com) request folder - a .bru file per call, zipped up
 * so it can be dropped straight into an existing Bruno collection. Bru file
 * format: https://docs.usebruno.com/bru-lang/overview
 *
 * `auth: inherit` on every request, deliberately, not `none` or a baked-in
 * token: these captured bodies need the same bearer token the original call
 * used, and that token is never stored (see IntegrationCallLog's own doc
 * comment - only bodies and non-secret routing context are logged) -
 * inheriting whatever auth the user's own collection/folder already has
 * configured is the only way these requests can actually be replayed after
 * import.
 */

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'request';
}

// Rewrites the captured absolute URL's scheme+host down to the
// {{fhir-api}}/{{openehr-api}} collection variable, keeping only path+query -
// captured logs store the literal host that answered at call time (whichever
// HIP sandbox/tenant was active), but a portable request must resolve the
// host from the importing user's own environment instead.
function toBruUrl(log: IntegrationCallLog): string {
  const envVar = log.protocol === 'fhir' ? '{{fhir-api}}' : '{{openehr-api}}';
  try {
    const parsed = new URL(log.url);
    return `${envVar}${parsed.pathname}${parsed.search}`;
  } catch {
    return log.url;
  }
}

function toBruRequest(log: IntegrationCallLog, seq: number): string {
  const method = log.method.toLowerCase();
  const name = `${log.resourceType} · ${log.operation}`.slice(0, 120);
  const hasBody = log.requestBody !== null && log.requestBody !== undefined;
  // Indented one level in, matching Bruno's own body:json convention: the
  // block's closing `}` must sit at column 1 so Bruno's parser can tell it
  // apart from the JSON payload's own closing `}`. An unindented JSON body
  // puts both closing braces at column 1, which either breaks Bruno's parser
  // outright or makes it treat the payload's own last line as the block
  // terminator, truncating the body it sends.
  const bodyJson = hasBody
    ? JSON.stringify(log.requestBody, null, 2).split('\n').map((line) => `  ${line}`).join('\n')
    : undefined;
  const contentType = log.protocol === 'fhir' ? 'application/fhir+json' : 'application/json';
  const docsLines = [
    `Captured: ${log.createdAt.toISOString()}`,
    `Protocol: ${log.protocol}`,
    `Resource type: ${log.resourceType}`,
    `Operation: ${log.operation}`,
    `Status: ${log.statusCode ?? '–'} (${log.success ? 'success' : 'failed'})`,
    log.ehrId ? `EHR id: ${log.ehrId}` : undefined,
    log.patientId ? `Patient id: ${log.patientId}` : undefined,
    log.fhirPatientId ? `FHIR patient id: ${log.fhirPatientId}` : undefined,
    log.errorMessage ? `Error: ${log.errorMessage}` : undefined,
  ].filter((line): line is string => Boolean(line)).join('\n');

  const lines: string[] = [
    'meta {',
    `  name: ${name}`,
    '  type: http',
    `  seq: ${seq}`,
    '}',
    '',
    `${method} {`,
    `  url: ${toBruUrl(log)}`,
  ];
  if (hasBody) lines.push('  body: json');
  const headerLines = log.protocol === 'fhir'
    ? [`  Accept: ${contentType}`, `  Content-Type: ${contentType}`]
    : [`  Content-Type: ${contentType}`];
  lines.push('  auth: inherit', '}', '', 'headers {', ...headerLines, '}');
  if (hasBody) lines.push('', 'body:json {', bodyJson!, '}');
  lines.push('', 'docs {', docsLines, '}', '');
  return lines.join('\n');
}

/** Streams a downloadable .zip response containing one Bruno folder
 * (folder.bru + one numbered .bru per call, oldest first). */
export function streamBrunoExport(res: Response, logs: IntegrationCallLog[], folderName: string): void {
  const folderSlug = slugify(folderName);
  const archive = archiver('zip', { zlib: { level: 9 } });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${folderSlug}-bruno.zip"`);
  archive.on('error', (error) => { throw error; });
  archive.pipe(res);

  // folder.bru names the folder itself once imported - without it Bruno
  // just shows the raw directory name. The auth block matters just as much:
  // Bruno folders default to auth mode "none", which would shadow the
  // parent collection's real auth even though every request below says
  // `auth: inherit` - explicit `mode: inherit` here is what actually lets
  // that inheritance reach the collection's configured token.
  archive.append(`meta {\n  name: ${folderName}\n}\n\nauth {\n  mode: inherit\n}\n`, { name: `${folderSlug}/folder.bru` });

  logs.forEach((log, index) => {
    const seq = index + 1;
    const filename = `${String(seq).padStart(3, '0')}-${slugify(log.protocol)}-${slugify(log.resourceType)}-${slugify(log.operation)}.bru`;
    archive.append(toBruRequest(log, seq), { name: `${folderSlug}/${filename}` });
  });

  void archive.finalize();
}
