import { getActiveEhrbaseConnection, type EhrbaseConnection } from './config.js';
import { resolveAuthorizationHeader } from './auth.js';

export class EhrbaseError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) {
    super(message);
  }
}

export interface EhrbaseTemplateSummary {
  template_id: string;
  version: string;
  concept: string;
  archetype_id: string;
  created_timestamp: string;
}

/** Direct client for EHRbase's own openEHR Definitions REST API
 * (`/definition/template/adl1.4`) - not proxied through Forms' apps/api at
 * all, so this keeps working for template authoring even while apps/api is
 * being worked on. Endpoint shapes and the upload content-type/response
 * contract are taken from what this repo's own
 * apps/api/src/services/ehrbaseService.ts (list/get) and
 * apps/api/tests/integration/ehrbase-template-smoke.test.js (the only place
 * in this repo that has ever exercised a real upload) already do against the
 * same EHRbase. */
export interface EhrbaseClientDeps {
  getConnection: () => EhrbaseConnection;
  resolveAuth: (connection: EhrbaseConnection) => Promise<string | undefined>;
  fetchImpl: typeof fetch;
}

const defaultDeps: EhrbaseClientDeps = { getConnection: getActiveEhrbaseConnection, resolveAuth: resolveAuthorizationHeader, fetchImpl: fetch };

class EhrbaseClient {
  constructor(private readonly deps: EhrbaseClientDeps = defaultDeps) {}

  private async baseUrl(): Promise<{ url: string; authHeader?: string }> {
    const connection = this.deps.getConnection();
    const url = connection.url.trim().replace(/\/$/, '');
    const authHeader = await this.deps.resolveAuth(connection);
    return { url, authHeader };
  }

  private async request(method: string, path: string, options: { accept?: string; contentType?: string; body?: string } = {}): Promise<{ status: number; text: string }> {
    const { url, authHeader } = await this.baseUrl();
    const response = await this.deps.fetchImpl(`${url}${path}`, {
      method,
      headers: {
        Accept: options.accept || 'application/json',
        ...(options.contentType ? { 'Content-Type': options.contentType } : {}),
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      ...(options.body !== undefined ? { body: options.body } : {}),
    });
    const text = await response.text();
    return { status: response.status, text };
  }

  /** `GET /definition/template/adl1.4` - every template EHRbase currently has
   * registered (id, version, concept, archetype id, when it was uploaded). */
  async listTemplates(): Promise<EhrbaseTemplateSummary[]> {
    const { status, text } = await this.request('GET', '/definition/template/adl1.4');
    if (status >= 400) throw new EhrbaseError(status, `Failed to list templates (HTTP ${status})`, tryParse(text));
    return text ? JSON.parse(text) : [];
  }

  /** `GET /definition/template/adl1.4/{id}` with `Accept:
   * application/openehr.wt+json` - the flattened WebTemplate JSON (every
   * field/path/RM type), the same representation Forms itself consumes when
   * importing a template. Use this to see what a template actually looks
   * like once EHRbase has processed it. */
  async getTemplateWebTemplate(templateId: string): Promise<unknown> {
    const { status, text } = await this.request('GET', `/definition/template/adl1.4/${encodeURIComponent(templateId)}`, { accept: 'application/openehr.wt+json' });
    if (status >= 400) throw new EhrbaseError(status, `Failed to fetch WebTemplate for '${templateId}' (HTTP ${status})`, tryParse(text));
    return JSON.parse(text);
  }

  /** `GET /definition/template/adl1.4/{id}` with `Accept: application/xml` -
   * the raw Operational Template XML EHRbase has stored. This is the
   * authorable artifact: fetch an existing, known-good template as a
   * structural reference before composing a new or modified one to upload. */
  async getTemplateOpt(templateId: string): Promise<string> {
    const { status, text } = await this.request('GET', `/definition/template/adl1.4/${encodeURIComponent(templateId)}`, { accept: 'application/xml' });
    if (status >= 400) throw new EhrbaseError(status, `Failed to fetch OPT XML for '${templateId}' (HTTP ${status})`, tryParse(text));
    return text;
  }

  /** `POST /definition/template/adl1.4` with `Content-Type: application/xml`
   * and the raw Operational Template XML as the body - registers a new
   * template (or a new version of one) with EHRbase. EHRbase validates the
   * OPT itself; a malformed one comes back as a 400/422 with the reason,
   * which is the real safety net here (there's no separate "design-time"
   * validator in front of it - this endpoint IS the validator). A template
   * id/version that already exists comes back 409, treated here as
   * "already there", not an error, since re-uploading an identical template
   * is a legitimate no-op. */
  async uploadTemplate(optXml: string): Promise<{ status: 'created' | 'already_exists' }> {
    const { status, text } = await this.request('POST', '/definition/template/adl1.4', { contentType: 'application/xml', body: optXml });
    if (status === 409) return { status: 'already_exists' };
    if (status >= 400) throw new EhrbaseError(status, `EHRbase rejected the template (HTTP ${status})`, tryParse(text));
    return { status: 'created' };
  }
}

function tryParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return text || undefined; }
}

export { EhrbaseClient };
export const ehrbaseClient = new EhrbaseClient();
