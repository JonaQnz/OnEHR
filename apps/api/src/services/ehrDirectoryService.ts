import axios from 'axios';
import { getEhrbaseRequestConfig } from './ehrbaseConnectionPlugins';
import { logIntegrationCall } from './integrationCallLogService';

/**
 * Files a just-committed Composition into the EHR's RM `FOLDER`/
 * `VERSIONED_FOLDER` directory tree, at the path configured on the Form via
 * `FORM_FOLDER_PATH_EXTENSION_KEY` (see packages/core/src/folder-mapping).
 * Called fire-and-forget right after a real submit
 * (formSessionService.ts's submitFormSessionToProvider), same spot and same
 * philosophy as verifyFhirForSubmission - never allowed to fail or delay
 * the submit itself.
 *
 * The directory PUT is a full-tree replace (not a patch), so a genuinely
 * concurrent submit against the same EHR can race and clobber. This is
 * mitigated with one retry (re-read, re-merge, re-write) but not a real
 * lock - documented v1 limit, acceptable because this app's own submit flow
 * only ever writes one Composition at a time per session.
 */

interface DvText { _type: 'DV_TEXT'; value: string; }
interface ObjectRef { _type: 'OBJECT_REF'; id: { _type: 'HIER_OBJECT_ID'; value: string }; namespace: string; type: string; }
interface Folder {
  _type?: 'FOLDER';
  name: DvText;
  archetype_node_id: string;
  folders?: Folder[];
  items?: ObjectRef[];
  [key: string]: unknown;
}

const GENERIC_FOLDER_ARCHETYPE_ID = 'openEHR-EHR-FOLDER.generic.v1';

function newFolder(name: string): Folder {
  return { _type: 'FOLDER', name: { _type: 'DV_TEXT', value: name }, archetype_node_id: GENERIC_FOLDER_ARCHETYPE_ID, folders: [], items: [] };
}

function directoryUrl(ehrbaseUrl: string, ehrId: string): string {
  return `${ehrbaseUrl}/ehr/${encodeURIComponent(ehrId)}/directory`;
}

/** Walks/creates `segments` under `root`, returning the deepest folder. */
function ensurePath(root: Folder, segments: string[]): Folder {
  let current = root;
  for (const segment of segments) {
    if (!current.folders) current.folders = [];
    let next = current.folders.find((f) => f.name?.value === segment);
    if (!next) {
      next = newFolder(segment);
      current.folders.push(next);
    }
    current = next;
  }
  return current;
}

async function loadDirectory(ehrbaseUrl: string, ehrId: string, headers: Record<string, string>, auth?: { username: string; password: string }): Promise<{ root: Folder; etag?: string; exists: boolean }> {
  const url = directoryUrl(ehrbaseUrl, ehrId);
  try {
    const response = await axios.get(url, { headers, ...(auth ? { auth } : {}) });
    logIntegrationCall({ protocol: 'openehr', resourceType: 'FOLDER', operation: 'read', method: 'GET', url, responseBody: response.data, statusCode: response.status, success: true, ehrId });
    // Confirmed live (see ehrStatusService.ts's own note on the same CDR
    // quirk): `If-Match` must be the bare, unquoted `uid.value`, not the
    // quoted ETag response header - that value fails with a misleading
    // "UUID string too large" 400 here too.
    return { root: response.data as Folder, etag: response.data?.uid?.value, exists: true };
  } catch (error: any) {
    if (error?.response?.status === 404) {
      logIntegrationCall({ protocol: 'openehr', resourceType: 'FOLDER', operation: 'read', method: 'GET', url, statusCode: 404, success: true, ehrId });
      return { root: newFolder('root'), exists: false };
    }
    throw error;
  }
}

async function writeDirectory(ehrbaseUrl: string, ehrId: string, headers: Record<string, string>, auth: { username: string; password: string } | undefined, root: Folder, etag: string | undefined, exists: boolean): Promise<void> {
  const url = directoryUrl(ehrbaseUrl, ehrId);
  const method = exists ? 'PUT' : 'POST';
  const requestHeaders = { ...headers, ...(exists && etag ? { 'If-Match': etag } : {}) };
  const response = exists
    ? await axios.put(url, root, { headers: requestHeaders, ...(auth ? { auth } : {}) })
    : await axios.post(url, root, { headers: requestHeaders, ...(auth ? { auth } : {}) });
  logIntegrationCall({ protocol: 'openehr', resourceType: 'FOLDER', operation: 'update', method, url, requestBody: root, responseBody: response.data, statusCode: response.status, success: true, ehrId });
}

/** `{year}` is resolved by the caller (packages/core's resolveFolderPath) -
 * this function only ever sees a fully-resolved path. */
export async function fileCompositionIntoFolder(ehrId: string, resolvedPath: string, compositionVersionUid: string): Promise<void> {
  const segments = resolvedPath.split('/').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return;
  // Confirmed live (2026-09-03): this CDR rejects a versioned uid here with
  // "Only UUIDs are supported as FOLDER.items.id.value" - FOLDER.items
  // wants a plain HIER_OBJECT_ID (the bare Composition UUID, no
  // "::system::version" suffix), not the OBJECT_VERSION_ID this app's own
  // commit results carry everywhere else. Always points at the
  // Composition's identity, not a specific version, matching how a
  // directory entry conceptually outlives any one version.
  const baseUid = compositionVersionUid.split('::')[0];
  const objectRef: ObjectRef = {
    _type: 'OBJECT_REF',
    id: { _type: 'HIER_OBJECT_ID', value: baseUid },
    namespace: 'local',
    // Confirmed live: this CDR normalizes/echoes 'COMPOSITION' back as
    // 'VERSIONED_COMPOSITION' regardless of what's sent - using the latter
    // directly here to match what it actually is (the folder entry points
    // at the Composition's version lineage, not one specific version).
    type: 'VERSIONED_COMPOSITION',
  };

  const { ehrbaseUrl, headers, auth } = await getEhrbaseRequestConfig();
  let attempt = 0;
  // One retry on a lost race (409/412 from a concurrent directory write) -
  // see this file's own doc comment on why a real lock isn't worth it here.
  while (attempt < 2) {
    attempt += 1;
    try {
      const { root, etag, exists } = await loadDirectory(ehrbaseUrl, ehrId, headers, auth);
      const target = ensurePath(root, segments);
      if (!target.items) target.items = [];
      const alreadyFiled = target.items.some((item) => item.id?.value === objectRef.id.value);
      if (!alreadyFiled) target.items.push(objectRef);
      // Still write even if already filed and this is the first attempt of
      // a fresh directory (exists=false) so the folder path itself gets
      // created even when re-filing the same composition is a no-op.
      if (alreadyFiled && exists) return;
      await writeDirectory(ehrbaseUrl, ehrId, headers, auth, root, etag, exists);
      return;
    } catch (error: any) {
      const status = error?.response?.status;
      if (attempt < 2 && (status === 409 || status === 412)) continue;
      logIntegrationCall({
        protocol: 'openehr', resourceType: 'FOLDER', operation: 'update', method: 'PUT', url: directoryUrl(ehrbaseUrl, ehrId),
        responseBody: error?.response?.data, statusCode: status, success: false,
        errorMessage: error instanceof Error ? error.message : String(error), ehrId,
      });
      console.warn('[ehrDirectoryService] Could not file composition into folder (best-effort, submit itself already succeeded):', error instanceof Error ? error.message : error);
      return;
    }
  }
}
