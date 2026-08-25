import type { ReactNode } from 'react';

/**
 * The host owns the visual workbench; document-specific adapters own the
 * semantics of their canvas.  This keeps the core package React-free while
 * making form and composition designers use the same integration seam.
 */
export type DesignerDocumentKind = 'clinical-form' | 'composition';

export type DesignerSurface = 'toolbar' | 'toolbox' | 'canvas' | 'inspector' | 'runtime';

export interface DesignerContext {
  documentId: string;
  kind: DesignerDocumentKind;
  /** The selected page or node, if the document type supports it. */
  selectionId?: string | null;
}

export interface DesignerAdapter {
  kind: DesignerDocumentKind;
  displayName: string;
  supports(surface: DesignerSurface): boolean;
}

/**
 * React-facing contribution contract.  Plugins can enhance a surface but do
 * not receive mutable document state: every edit remains owned by its adapter.
 */
export interface DesignerExtensionContribution {
  id: string;
  documentKinds: readonly DesignerDocumentKind[];
  surface: DesignerSurface;
  render(context: DesignerContext): ReactNode;
}

export const clinicalFormDesignerAdapter: DesignerAdapter = {
  kind: 'clinical-form',
  displayName: 'Formular',
  supports: () => true,
};

export const compositionDesignerAdapter: DesignerAdapter = {
  kind: 'composition',
  displayName: 'Composition',
  supports: () => true,
};
