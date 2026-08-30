import { XMLBuilder } from 'fast-xml-parser';
import type { ComponentProjection, XmlNode } from './types.js';

/** Re-uses the exact COMPOSITION.report.v1 wrapper shape already proven this
 * session (see the scratchpad opt-builder.mjs this module supersedes for
 * assembling *composed* documents): fixed category=openehr::433, the same
 * minimal context/EVENT_CONTEXT/ITEM_TREE[at0001]/Status[at0005] block every
 * real, working OPT on this deployment already carries. */
const COMPOSITION_ARCHETYPE_ID = 'openEHR-EHR-COMPOSITION.report.v1';
/** A real, well-known CKM archetype ("used to represent an arbitrary section
 * of a document with no more specific semantics") - the compiler's own
 * wrapper node when a component needs a labeled grouping it doesn't already
 * have. Its own root at-code is always "at0000" - at-codes are scoped per
 * archetype terminology, not globally unique in the OPERATIONAL_TEMPLATE, so
 * every independently-rooted C_ARCHETYPE_ROOT (including this one) may reuse
 * "at0000" for its own root without colliding with any other archetype's
 * "at0000", including the projections it wraps. */
const ADHOC_SECTION_ARCHETYPE_ID = 'openEHR-EHR-SECTION.adhoc.v1';

const xmlBuilder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', suppressEmptyNode: true });

function esc(value: string): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function occurrences(lower: number, upperUnbounded: boolean, upper?: number): string {
  return `<occurrences><lower_included>true</lower_included><upper_included>${upperUnbounded ? 'false' : 'true'}</upper_included><lower_unbounded>false</lower_unbounded><upper_unbounded>${upperUnbounded ? 'true' : 'false'}</upper_unbounded><lower>${lower}</lower>${upperUnbounded ? '' : `<upper>${upper}</upper>`}</occurrences>`;
}

function existence(lower: number, upper: number): string {
  return `<existence><lower_included>true</lower_included><upper_included>true</upper_included><lower_unbounded>false</lower_unbounded><upper_unbounded>false</upper_unbounded><lower>${lower}</lower><upper>${upper}</upper></existence>`;
}

function termDefinitionsXml(entries: Array<{ code: string; text: string; description?: string }>): string {
  return entries.map(({ code, text, description }) => `<term_definitions code="${code}"><items id="text">${esc(text)}</items><items id="description">${esc(description || '')}</items></term_definitions>`).join('');
}

/** A fixed `name` attribute constraint (existence 1..1, exactly one allowed
 * DV_TEXT value) - the exact shape reverse-engineered live from
 * vg_Diagnosis.v1.1.1's real OPT, where it disambiguates two uses of the
 * SAME archetype_id ("primary diagnosis" / "secondary diagnosis"; see
 * componentResolver.ts's `sourceName`). Every wrapper SECTION this compiler
 * creates needs exactly this: without it, two SECTION.adhoc.v1 wrappers -
 * same archetype_id, same node_id "at0000" - are indistinguishable RM
 * identities to EHRbase, which merges them into ONE content slot and rejects
 * more than one real instance of it (confirmed live: EHRbase 422 "Attribute
 * has 4 occurrences, but must be 0..1" the first time this was omitted). The
 * openehr-engine composition builder already fills a fixed single-value name
 * constraint like this automatically at submit time (proven by every
 * existing "primary diagnosis"-style form already working) - no new form
 * field is needed for it. */
function fixedNameAttributeXml(text: string): string {
  return `<attributes xsi:type="C_SINGLE_ATTRIBUTE"><rm_attribute_name>name</rm_attribute_name>${existence(1, 1)}<match_negated>false</match_negated><children xsi:type="C_COMPLEX_OBJECT"><rm_type_name>DV_TEXT</rm_type_name>${occurrences(1, false, 1)}<node_id/><attributes xsi:type="C_SINGLE_ATTRIBUTE"><rm_attribute_name>value</rm_attribute_name>${existence(1, 1)}<match_negated>false</match_negated><children xsi:type="C_PRIMITIVE_OBJECT"><rm_type_name>STRING</rm_type_name>${occurrences(1, false, 1)}<node_id/><item xsi:type="C_STRING"><list>${esc(text)}</list></item></children></attributes></children></attributes>`;
}

/** Re-serializes a ComponentProjection's already-parsed C_ARCHETYPE_ROOT
 * subtree back to XML, byte-for-byte structurally unchanged (no renumbering,
 * no rewriting - see componentResolver.ts). */
function serializeProjectionNode(node: XmlNode): string {
  return xmlBuilder.build({ children: node });
}

/** Wraps one projection's XML in a new, compiler-authored ad-hoc SECTION
 * archetype root, giving the assembled document a labeled grouping even
 * though the source component itself is not already a SECTION. This is the
 * exact same "independent nested C_ARCHETYPE_ROOT with its own
 * archetype_id/term_definitions" shape this session already used successfully
 * for slot-filling (see opt-builder.mjs's slotArchetypes) - not a new XML
 * shape, just the same technique applied at the document's `content` level
 * instead of inside one archetype's own SLOT. */
function buildAdhocSectionWrapper(projection: ComponentProjection): string {
  const name = fixedNameAttributeXml(projection.label);
  const items = `<attributes xsi:type="C_MULTIPLE_ATTRIBUTE"><rm_attribute_name>items</rm_attribute_name>${existence(0, 1)}<match_negated>false</match_negated>${serializeProjectionNode(projection.node)}</attributes>`;
  const terms = termDefinitionsXml([{ code: 'at0000', text: projection.label, description: `Section: ${projection.label}` }]);
  return `<children xsi:type="C_ARCHETYPE_ROOT"><rm_type_name>SECTION</rm_type_name>${occurrences(0, false, 1)}<node_id>at0000</node_id>${name}${items}<archetype_id><value>${ADHOC_SECTION_ARCHETYPE_ID}</value></archetype_id>${terms}</children>`;
}

function buildContentChild(projection: ComponentProjection): string {
  return projection.wrapInSection ? buildAdhocSectionWrapper(projection) : serializeProjectionNode(projection.node);
}

export interface CompileOptions {
  templateId: string;
  uid: string;
  purpose: string;
  compositionRootText: string;
  compositionRootDescription: string;
  components: ComponentProjection[];
}

/** Assembles the final OPT XML: one COMPOSITION.report.v1 wrapper around
 * every component's projection (content existence raised to 0..N, unlike the
 * single-content-item opt-builder.mjs this supersedes for composed
 * documents). Every projection's own at-codes/term_definitions are carried
 * over completely untouched - see componentResolver.ts and
 * buildAdhocSectionWrapper's own comment for why that's correct, not merely
 * convenient. */
export function compileOperationalTemplate(options: CompileOptions): string {
  if (options.components.length === 0) throw new Error('Document Template braucht mindestens eine Component.');

  const contentChildren = options.components.map(buildContentChild).join('');
  const contentAttr = `<attributes xsi:type="C_MULTIPLE_ATTRIBUTE" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><rm_attribute_name>content</rm_attribute_name>${existence(0, options.components.length)}<cardinality><is_ordered>false</is_ordered><is_unique>false</is_unique><interval><lower_included>true</lower_included><upper_included>false</upper_included><lower_unbounded>false</lower_unbounded><upper_unbounded>true</upper_unbounded><lower>1</lower></interval></cardinality><match_negated>false</match_negated>${contentChildren}</attributes>`;

  const categoryAttr = `<attributes xsi:type="C_SINGLE_ATTRIBUTE" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><rm_attribute_name>category</rm_attribute_name>${existence(1, 1)}<match_negated>false</match_negated><children xsi:type="C_COMPLEX_OBJECT"><rm_type_name>DV_CODED_TEXT</rm_type_name>${occurrences(1, false, 1)}<node_id/><attributes xsi:type="C_SINGLE_ATTRIBUTE"><rm_attribute_name>defining_code</rm_attribute_name>${existence(1, 1)}<match_negated>false</match_negated><children xsi:type="C_CODE_PHRASE"><rm_type_name>CODE_PHRASE</rm_type_name>${occurrences(1, false, 1)}<node_id/><terminology_id><value>openehr</value></terminology_id><code_list>433</code_list></children></attributes></children></attributes>`;

  const contextAttr = `<attributes xsi:type="C_SINGLE_ATTRIBUTE" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><rm_attribute_name>context</rm_attribute_name>${existence(0, 1)}<match_negated>false</match_negated><children xsi:type="C_COMPLEX_OBJECT"><rm_type_name>EVENT_CONTEXT</rm_type_name>${occurrences(1, false, 1)}<node_id/><attributes xsi:type="C_SINGLE_ATTRIBUTE"><rm_attribute_name>other_context</rm_attribute_name>${existence(0, 1)}<match_negated>false</match_negated><children xsi:type="C_COMPLEX_OBJECT"><rm_type_name>ITEM_TREE</rm_type_name>${occurrences(1, false, 1)}<node_id>at0001</node_id><attributes xsi:type="C_MULTIPLE_ATTRIBUTE"><rm_attribute_name>items</rm_attribute_name>${existence(0, 1)}<match_negated>false</match_negated><children xsi:type="C_COMPLEX_OBJECT"><rm_type_name>ELEMENT</rm_type_name>${occurrences(0, false, 1)}<node_id>at0005</node_id><attributes xsi:type="C_SINGLE_ATTRIBUTE"><rm_attribute_name>value</rm_attribute_name>${existence(0, 1)}<match_negated>false</match_negated><children xsi:type="C_COMPLEX_OBJECT"><rm_type_name>DV_TEXT</rm_type_name>${occurrences(1, false, 1)}<node_id/></children></attributes></children></attributes></children></attributes></children></attributes>`;

  const compositionTerms = termDefinitionsXml([
    { code: 'at0000', text: options.compositionRootText, description: options.compositionRootDescription },
    { code: 'at0001', text: 'Tree', description: '@ internal @' },
    { code: 'at0005', text: 'Status', description: 'The status of the entire report. Note: This is not the status of any of the report components.' },
  ]);

  return `<template xmlns="http://schemas.openehr.org/v1">
  <language><terminology_id><value>ISO_639-1</value></terminology_id><code_string>en</code_string></language>
  <description>
    <original_author id="date">${new Date().toISOString().slice(0, 10)}</original_author>
    <lifecycle_state>in_development</lifecycle_state>
    <other_details id="licence"/>
    <other_details id="custodian_organisation"/>
    <other_details id="original_namespace"/>
    <other_details id="original_publisher"/>
    <other_details id="custodian_namespace"/>
    <other_details id="sem_ver">0.1.0</other_details>
    <other_details id="build_uid"/>
    <other_details id="MD5-CAM-1.0.1">00000000000000000000000000000000</other_details>
    <details>
      <language><terminology_id><value>ISO_639-1</value></terminology_id><code_string>en</code_string></language>
      <purpose>${esc(options.purpose)}</purpose>
    </details>
  </description>
  <uid><value>${options.uid}</value></uid>
  <template_id><value>${options.templateId}</value></template_id>
  <concept>${options.templateId}</concept>
  <definition>
    <rm_type_name>COMPOSITION</rm_type_name>
    ${occurrences(1, false, 1)}
    <node_id>at0000</node_id>
    ${categoryAttr}
    ${contextAttr}
    ${contentAttr}
    <archetype_id><value>${COMPOSITION_ARCHETYPE_ID}</value></archetype_id>
    <template_id><value>${options.templateId}</value></template_id>
    ${compositionTerms}
  </definition>
</template>
`;
}
