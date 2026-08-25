import type { ReactNode } from 'react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import type { DesignerDocumentKind } from './contracts';

export interface DesignerShellProps {
  kind: DesignerDocumentKind;
  children: ReactNode;
  /** Both document types use the same native HTML5 drag boundary. */
  dragAndDrop?: boolean;
  className?: string;
}

export function DesignerShell({ kind, children, dragAndDrop = false, className }: DesignerShellProps) {
  const content = <div className={className} data-designer-kind={kind}>{children}</div>;
  return dragAndDrop ? <DndProvider backend={HTML5Backend}>{content}</DndProvider> : content;
}

export interface DesignerWorkspaceProps {
  header: ReactNode;
  navigation: ReactNode;
  canvas: ReactNode;
  inspector: ReactNode;
  navigationWidth?: number;
  inspectorWidth?: number;
}

/** Shared three-pane geometry for all document designers. */
export function DesignerWorkspace({
  header,
  navigation,
  canvas,
  inspector,
  navigationWidth = 245,
  inspectorWidth = 310,
}: DesignerWorkspaceProps) {
  return <div style={{ minHeight: '100vh', background: '#f8fafc', color: '#0f172a' }}>
    {header}
    <div style={{ display: 'grid', gridTemplateColumns: `${navigationWidth}px minmax(0, 1fr) ${inspectorWidth}px`, minHeight: 'calc(100vh - 62px)' }}>
      <aside style={{ background: '#fff', borderRight: '1px solid #e2e8f0', padding: '1rem' }}>{navigation}</aside>
      <main style={{ minWidth: 0 }}>{canvas}</main>
      <aside style={{ background: '#fff', borderLeft: '1px solid #e2e8f0', padding: '1rem' }}>{inspector}</aside>
    </div>
  </div>;
}
