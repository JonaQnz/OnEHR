import React, { createContext, useContext, useState, useMemo, useEffect } from 'react';
import { 
  AqlPrefillConfiguration, 
  PrefillFieldState, 
  PrefillProvenance, 
  PrefillRuntimeContext
} from '../types/aqlPrefill';
import { loadAqlPrefillData, applyPrefillField, applyPrefillGroup, applyPrefillForm } from '../state/aqlPrefillStore';
import { PrefillConflictDialog, ConflictItem } from './PrefillConflictDialog';
import { FieldPrefillButton, FieldPrefillStatus } from './FieldPrefillButton';
import { GroupPrefillButton } from './GroupPrefillButton';
import { FormPrefillButton } from './FormPrefillButton';

interface AqlPrefillContextType {
  prefillLoading: boolean;
  fieldStates: Record<string, PrefillFieldState>;
  fieldStatusMap: Record<string, FieldPrefillStatus>;
  provenanceMap: Record<string, PrefillProvenance>;
  executePrefillAction: (scope: 'field' | 'group' | 'form', targetId?: string, forceOverwrite?: boolean) => Promise<void>;
  aqlConfig?: AqlPrefillConfiguration;
}

const AqlContext = createContext<AqlPrefillContextType | null>(null);

export function useAqlPrefill() {
  return useContext(AqlContext);
}

export function AqlPrefillProvider({ 
  children, 
  values, 
  setValues, 
  definition, 
  patientId, 
  ehrId, 
  encounterId 
}: { 
  children: React.ReactNode;
  values: Record<string, unknown>;
  setValues: (values: Record<string, unknown>) => void;
  definition: any;
  patientId?: string;
  ehrId?: string;
  encounterId?: string;
}) {
  const aqlConfig = useMemo<AqlPrefillConfiguration | undefined>(() => {
    return definition?.settings?.aqlPrefill;
  }, [definition]);

  const [fieldStates, setFieldStates] = useState<Record<string, PrefillFieldState>>({});
  const [fieldStatusMap, setFieldStatusMap] = useState<Record<string, FieldPrefillStatus>>({});
  const [provenanceMap, setProvenanceMap] = useState<Record<string, PrefillProvenance>>({});
  const [prefillLoading, setPrefillLoading] = useState(false);
  const [hasAutoLoaded, setHasAutoLoaded] = useState(false);

  const [conflictDialog, setConflictDialog] = useState<{
    isOpen: boolean;
    conflicts: ConflictItem[];
    pendingScope: 'field' | 'group' | 'form';
    targetId?: string;
  }>({ isOpen: false, conflicts: [], pendingScope: 'form' });

  const runtimeContext = useMemo<PrefillRuntimeContext>(() => ({
    patientId: patientId || ehrId || '',
    ehrId: ehrId || patientId || '',
    encounterId: encounterId || '',
    templateId: definition?.templateId || definition?.template_id || definition?.webTemplate?.templateId,
    formValues: values,
    formFields: (definition?.layout ? collectFields(definition.layout) : []).map((f: any) => ({
      id: f.id,
      aqlPath: f.aqlPath || f.binding?.openehr?.path || (typeof f.id === 'string' && f.id.startsWith('/') ? f.id : undefined),
      name: f.name || f.label,
      templateId: f.binding?.openehr?.templateAlias || definition?.templateId,
      rmType: f.binding?.openehr?.rmType || f.semanticType,
      nodeId: f.archetypeNodeId,
    })),
  }), [patientId, ehrId, encounterId, values, definition]);

  const executePrefillAction = async (scope: 'field' | 'group' | 'form', targetId?: string, forceOverwrite = false) => {
    if (!aqlConfig) return;
    setPrefillLoading(true);

    try {
      const loadResult = await loadAqlPrefillData(aqlConfig, runtimeContext, {
        currentValues: values,
        fieldStates,
        forceRefresh: scope === 'form' && targetId === 'refresh',
      });

      const cacheEntry = loadResult.cacheEntry;

      let applyResult;
      if (scope === 'field' && targetId) {
        applyResult = applyPrefillField(aqlConfig, cacheEntry, targetId, values, fieldStates, { forceOverwrite });
      } else if (scope === 'group' && targetId) {
        applyResult = applyPrefillGroup(aqlConfig, cacheEntry, targetId, values, fieldStates, { forceOverwrite });
      } else {
        applyResult = applyPrefillForm(aqlConfig, cacheEntry, values, fieldStates, { forceOverwrite });
      }

      if (!applyResult.success && applyResult.conflicts && applyResult.conflicts.length > 0) {
        setConflictDialog({
          isOpen: true,
          conflicts: applyResult.conflicts.map((c) => ({
            fieldId: c.fieldId,
            fieldLabel: c.fieldId, // simplified
            currentValue: c.currentValue,
            prefillValue: c.prefillValue,
          })),
          pendingScope: scope,
          targetId,
        });
        return;
      }

      if (applyResult.success) {
        setValues(applyResult.updatedValues);
        setFieldStates(applyResult.updatedStates);

        const newProv = { ...provenanceMap };
        const newStatus = { ...fieldStatusMap };
        for (const prov of applyResult.provenanceList) {
          for (const m of aqlConfig.mappings || []) {
            if (m.target.fieldId) {
              newProv[m.target.fieldId] = prov;
              newStatus[m.target.fieldId] = 'applied';
            }
          }
        }
        setProvenanceMap(newProv);
        setFieldStatusMap(newStatus);
      }
    } catch (err) {
      if (scope === 'field' && targetId) {
        setFieldStatusMap((prev) => ({ ...prev, [targetId]: 'error' }));
      }
    } finally {
      setPrefillLoading(false);
    }
  };

  useEffect(() => {
    if (aqlConfig?.executionMode === 'automatic' && !hasAutoLoaded && !prefillLoading && runtimeContext.patientId) {
      setHasAutoLoaded(true);
      void executePrefillAction('form');
    }
  }, [aqlConfig?.executionMode, hasAutoLoaded, prefillLoading, runtimeContext.patientId]);

  if (!aqlConfig) return <>{children}</>;

  return (
    <AqlContext.Provider value={{
      prefillLoading,
      fieldStates,
      fieldStatusMap,
      provenanceMap,
      executePrefillAction,
      aqlConfig
    }}>
      {children}
      <PrefillConflictDialog
        isOpen={conflictDialog.isOpen}
        conflicts={conflictDialog.conflicts}
        onCancel={() => setConflictDialog({ isOpen: false, conflicts: [], pendingScope: 'form' })}
        onKeepManual={() => setConflictDialog({ isOpen: false, conflicts: [], pendingScope: 'form' })}
        onOverwriteAll={() => {
          const { pendingScope, targetId } = conflictDialog;
          setConflictDialog({ isOpen: false, conflicts: [], pendingScope: 'form' });
          void executePrefillAction(pendingScope, targetId, true);
        }}
      />
    </AqlContext.Provider>
  );
}

// Helpers
function collectFields(node: any, fields: any[] = []): any[] {
  if (node.type === 'input' || node.id || node.name) fields.push(node);
  if (node.children) node.children.forEach((c: any) => collectFields(c, fields));
  return fields;
}

export function AqlFieldActionWrapper({ fieldId, readOnly }: { fieldId: string; readOnly?: boolean }) {
  const ctx = useAqlPrefill();
  if (!ctx || !ctx.aqlConfig || readOnly) return null;

  const fieldBehavior = (ctx.aqlConfig.fieldConfigs || []).find((c) => c.fieldId === fieldId)?.behavior || 'auto';
  if (fieldBehavior !== 'button') return null;

  return (
    <FieldPrefillButton
      fieldId={fieldId}
      status={ctx.fieldStatusMap[fieldId] || 'idle'}
      disabled={ctx.prefillLoading}
      fieldState={ctx.fieldStates[fieldId]}
      provenance={ctx.provenanceMap[fieldId]}
      onApplyField={(id) => void ctx.executePrefillAction('field', id)}
    />
  );
}

export function AqlGroupActionWrapper({ groupId, label, readOnly }: { groupId: string; label?: string; readOnly?: boolean }) {
  const ctx = useAqlPrefill();
  if (!ctx || !ctx.aqlConfig || readOnly) return null;

  const hasGroupMapping = (ctx.aqlConfig.mappings || []).some((m) => m.target.groupId === groupId || (label && m.target.groupId === label));
  if (!hasGroupMapping) return null;

  return (
    <GroupPrefillButton
      groupId={groupId}
      groupLabel={label}
      loading={ctx.prefillLoading}
      disabled={ctx.prefillLoading}
      onApplyGroup={(id) => void ctx.executePrefillAction('group', id)}
    />
  );
}

export function AqlFormActionWrapper({ readOnly }: { readOnly?: boolean }) {
  const ctx = useAqlPrefill();
  if (!ctx || !ctx.aqlConfig || readOnly) return null;

  return (
    <FormPrefillButton
      loading={ctx.prefillLoading}
      disabled={ctx.prefillLoading}
      onApplyForm={() => void ctx.executePrefillAction('form')}
      onRefreshData={() => void ctx.executePrefillAction('form', 'refresh')}
    />
  );
}
