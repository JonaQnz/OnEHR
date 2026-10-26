import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkbenchContext } from '../../context';
import { listAllCapabilities, resolveCapability } from '../../capability/catalog';
import { listStationCapabilities } from '../../scenario/protocol';
import { toResult } from '../toResult';

const capabilityName = z.string().describe('A capability name, e.g. "coded-diagnosis" or "lab-value" - see list_capabilities for the known ones.');

/**
 * User's own ask: "Form Builder as a capability" - resolving/registering an
 * openEHR capability binding (which Composition/block/Form Section backs
 * it) should be a first-class MCP-tool-level operation, not a human editing
 * capability/catalog.ts's static TS object by hand every time a new one
 * (like coded-diagnosis/lab-value/order-basis this session) gets built.
 *
 * Deliberately flag-and-assist, not autonomous (user's own answer): this
 * server never creates a Form itself. `resolve_capability` tells the
 * caller a Form Section needs to be designed+published (via the
 * `openehr-architect` agent, matching the "X (Basis) – Einzelformular"
 * pattern), live-verified, and THEN registered with `register_capability`.
 * `request_missing_form` files a visible task (reusing the existing critic
 * TaskStore, not a new mechanism) so the gap is tracked even if no one
 * acts on it immediately.
 */
export function registerCapabilityTools(server: McpServer, context: WorkbenchContext): void {
  server.registerTool('list_capabilities', {
    title: 'List every known openEHR capability and which station kinds use it',
    description: 'Merges the hand-reviewed static catalog (capability/catalog.ts) with anything registered later via register_capability. Each entry carries role ("basis" - one of the canonical "X (Basis)" Form Sections - or "composed", conceptually extending a basis one via its own basedOn), its Composition/block/Form Section binding, and (for a dynamically-registered one) an optional description. Also returns the declared capability list per StationKind (scenario/protocol.ts), so a caller can see what a given station is meant to use.',
    inputSchema: {},
  }, () => toResult(async () => ({
    capabilities: listAllCapabilities(context.clinicDeps().dynamicCapabilities),
    stationCapabilities: listStationCapabilities(),
  })));

  server.registerTool('resolve_capability', {
    title: 'Check whether a Form Builder binding exists for a capability name',
    description: 'Looks up `name` in the dynamic registry then the static catalog (same precedence as the engine\'s own lookup). Returns { resolved: true, config } when a binding exists, or { resolved: false, name, suggestion } when it does not - the suggestion points at the openehr-architect agent + the "X (Basis) – Einzelformular" Composition-wrapper pattern already used by every existing capability, followed by register_capability once the new Form is live-verified. Never creates anything itself.',
    inputSchema: { name: capabilityName },
  }, ({ name }) => toResult(async () => {
    const config = resolveCapability(name, context.clinicDeps().dynamicCapabilities);
    if (config) return { resolved: true, name, config };
    return {
      resolved: false,
      name,
      suggestion:
        `No Form Builder binding known for capability "${name}". Use the openehr-architect agent to find or design+publish a `
        + 'Form Section for this clinical concept (prefer an existing "X (Basis)" form when one fits - see capability/catalog.ts\'s '
        + 'own "basis" entries), wrap it in a standalone Composition the same way as every existing "X (Basis) – Einzelformular", '
        + 'live-verify it end to end (start_composition_session -> create_form_session -> attach_composition_block -> '
        + 'validate_composition_session -> submit_form_session_to_provider -> an AQL read-back), then call register_capability.',
    };
  }));

  server.registerTool('register_capability', {
    title: 'Register a live-verified capability binding',
    description: 'Writes a capability\'s Composition/block/Form Section binding into the dynamic registry (capability/dynamicRegistry.ts), so requireOpenEhrCapabilityConfig/resolve_capability find it from now on - the actual "Form Builder as a capability" mechanism, replacing a human hand-editing capability/catalog.ts. Only call this AFTER live-verifying the binding actually submits (see resolve_capability\'s own suggestion for the exact steps) - this tool does not validate the ids itself.',
    inputSchema: {
      name: capabilityName,
      role: z.enum(['basis', 'composed']).describe('"basis" if this Form Section IS one of the canonical "X (Basis)" forms; "composed" otherwise.'),
      basedOn: z.string().optional().describe('For a "composed" capability, the basis capability name it conceptually extends.'),
      description: z.string().optional().describe('Short human-readable description, shown by list_capabilities.'),
      compositionFormId: z.string().describe('The standalone Composition-kind Form\'s id this capability submits through.'),
      blockId: z.string().describe('The block, within that Composition, this capability\'s Form Section fills.'),
      formSectionFormId: z.string().describe('The embedded Form Section\'s own id.'),
      forceNewComposition: z.boolean().describe('true for a repeatable capability (a new Composition per occurrence); false to resume the same session on a second call.'),
    },
  }, ({ name, role, basedOn, description, compositionFormId, blockId, formSectionFormId, forceNewComposition }) => toResult(async () =>
    context.clinicDeps().dynamicCapabilities.register(name, { role, basedOn, description, compositionFormId, blockId, formSectionFormId, forceNewComposition })));

  server.registerTool('request_missing_form', {
    title: 'File a visible task for a capability that has no Form Builder binding yet',
    description: 'Flags a missing capability as a tracked, visible gap (reuses the existing critic Task system, critic/taskStore.ts - the same mechanism a critic finding like "missing-discharge-letter" uses) rather than creating anything automatically. Idempotent per capabilityName within one scenario run.',
    inputSchema: {
      scenarioRunId: z.string().describe('The scenario run this gap was hit on.'),
      stationKind: z.string().describe('Which station kind needed this capability, e.g. "general-ward".'),
      capabilityName,
      description: z.string().optional().describe('Extra context on what this capability should cover, for whoever picks up the task.'),
    },
  }, ({ scenarioRunId, stationKind, capabilityName, description }) => toResult(async () => {
    const { tasks } = context.forRun(scenarioRunId);
    return tasks.ensure({
      id: `missing-form:${capabilityName}`,
      code: 'missing-form',
      anchorEventId: `capability:${capabilityName}`,
      description: `Station "${stationKind}" braucht die Capability "${capabilityName}", aber es existiert noch keine Form Builder-Bindung dafür.${description ? ` ${description}` : ''}`,
      // Manually filed, not a critic/rules.ts finding - resolveStale must
      // never auto-close this just because "missing-form" isn't a code the
      // deterministic critic itself produces (a real bug found live: this
      // exact task was silently marked resolved on the very next Step
      // regardless of whether register_capability had actually been
      // called). Close it explicitly once the capability is registered -
      // see resolve_capability/register_capability above, or TaskStore's
      // own `resolve(id)`.
      source: 'manual',
    });
  }));
}
