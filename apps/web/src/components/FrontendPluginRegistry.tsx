import React, { createContext, useContext, ReactNode, useMemo } from 'react';

export type UIExtensionSlotName = 
  | 'form:wrapper' 
  | 'form:header:actions' 
  | 'form:field:actions' 
  | 'form:group:actions' 
  | 'form:overlay';

export interface UIExtensionContribution {
  pluginId: string;
  slot: UIExtensionSlotName;
  component: React.ComponentType<any>;
}

export interface CustomFieldContribution {
  pluginId: string;
  key: string;
  component: React.ComponentType<any>;
  toolboxItem: {
    element: string;
    name: string;
    icon: string;
    label?: string;
    static?: boolean;
    content?: string;
    custom_metadata?: any;
    field_name?: string;
  };
}

export interface RuntimeRendererContribution {
  pluginId: string;
  uiElement: string;
  renderer: (props: any) => React.ReactNode;
}

export interface FrontendPluginRegistrar {
  registerExtension: (extension: UIExtensionContribution) => void;
  registerField: (field: CustomFieldContribution) => void;
  registerRenderer: (renderer: RuntimeRendererContribution) => void;
}

interface PluginRegistryContextType {
  extensions: UIExtensionContribution[];
  customFields: CustomFieldContribution[];
  renderers: Record<string, (props: any) => React.ReactNode>;
  registerExtension: (extension: UIExtensionContribution) => void;
}

const PluginRegistryContext = createContext<PluginRegistryContextType>({ 
  extensions: [], 
  customFields: [],
  renderers: {},
  registerExtension: () => {} 
});

export function FrontendPluginProvider({ children, plugins = [] }: { children: ReactNode, plugins?: Array<(register: FrontendPluginRegistrar) => void> }) {
  const { initialExtensions, initialCustomFields, initialRenderers } = React.useMemo(() => {
    const exts: UIExtensionContribution[] = [];
    const fields: CustomFieldContribution[] = [];
    const rends: Record<string, (props: any) => React.ReactNode> = {};
    const registrar: FrontendPluginRegistrar = {
      registerExtension: (ext) => {
        if (!exts.some(p => p.pluginId === ext.pluginId && p.slot === ext.slot)) exts.push(ext);
      },
      registerField: (field) => {
        if (!fields.some(p => p.pluginId === field.pluginId && p.key === field.key)) fields.push(field);
      },
      registerRenderer: (renderer) => {
        if (!rends[renderer.uiElement]) rends[renderer.uiElement] = renderer.renderer;
      }
    };
    plugins.forEach(pluginInit => pluginInit(registrar));
    return { initialExtensions: exts, initialCustomFields: fields, initialRenderers: rends };
  }, [plugins]);

  const [extensions, setExtensions] = React.useState<UIExtensionContribution[]>(initialExtensions);
  const [customFields, setCustomFields] = React.useState<CustomFieldContribution[]>(initialCustomFields);
  const [renderers, setRenderers] = React.useState<Record<string, (props: any) => React.ReactNode>>(initialRenderers);

  React.useEffect(() => {
    setExtensions(initialExtensions);
    setCustomFields(initialCustomFields);
    setRenderers(initialRenderers);
  }, [initialExtensions, initialCustomFields, initialRenderers]);

  return (
    <PluginRegistryContext.Provider value={{ extensions, customFields, renderers, registerExtension: (ext) => setExtensions(p => [...p, ext]) }}>
      {children}
    </PluginRegistryContext.Provider>
  );
}

export function useFrontendPlugins() {
  return useContext(PluginRegistryContext);
}

export function ExtensionSlot({ name, context }: { name: UIExtensionSlotName, context?: any }) {
  const { extensions } = useFrontendPlugins();
  const matched = useMemo(() => extensions.filter(ext => ext.slot === name), [extensions, name]);
  
  if (matched.length === 0) return null;

  return (
    <>
      {matched.map((ext, idx) => (
        <ext.component key={`${ext.pluginId}-${idx}`} {...context} />
      ))}
    </>
  );
}

export function ExtensionWrapperSlot({ name, context, children }: { name: UIExtensionSlotName, context?: any, children: ReactNode }) {
  const { extensions } = useFrontendPlugins();
  const matched = useMemo(() => extensions.filter(ext => ext.slot === name), [extensions, name]);
  
  return matched.reduce((acc, ext, idx) => (
    <ext.component key={`${ext.pluginId}-${idx}`} {...context}>
      {acc}
    </ext.component>
  ), children);
}
