import { randomUUID } from 'node:crypto';
import { ehrbaseClient } from '../ehrbaseClient.js';
import { resolveComponents } from './componentResolver.js';
import { compileOperationalTemplate } from './operationalTemplateCompiler.js';
import type { DocumentComponent } from './types.js';

export interface ComposeDocumentTemplateInput {
  /** New template_id to register on EHRbase, e.g. "entlassbrief_v1". */
  templateId: string;
  /** Human-readable purpose/description stored in the OPT itself. */
  purpose: string;
  /** Root COMPOSITION display name, e.g. "Entlassbrief". */
  name: string;
  components: DocumentComponent[];
}

export interface ComposeDocumentTemplateResult {
  templateId: string;
  optXml: string;
  upload: { status: 'created' | 'already_exists' };
}

/** The full DocumentTemplate -> ComponentResolver -> ComponentProjection[] ->
 * OperationalTemplateCompiler -> OPT -> upload_ehrbase_template pipeline in
 * one call. Reuses the *existing*, unchanged upload path
 * (EhrbaseClient.uploadTemplate) - composing the OPT is the only new step;
 * everything downstream of a valid OPT (upload, WebTemplate parsing, Form
 * generation) already works unmodified for a multi-component template, see
 * the plan's Context section. */
export async function composeDocumentTemplate(input: ComposeDocumentTemplateInput): Promise<ComposeDocumentTemplateResult> {
  const components = await resolveComponents(ehrbaseClient, input.components);
  const optXml = compileOperationalTemplate({
    templateId: input.templateId,
    uid: randomUUID(),
    purpose: input.purpose,
    compositionRootText: input.name,
    compositionRootDescription: input.purpose,
    components,
  });
  const upload = await ehrbaseClient.uploadTemplate(optXml);
  return { templateId: input.templateId, optXml, upload };
}
