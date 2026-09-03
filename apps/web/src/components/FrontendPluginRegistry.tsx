import React, { createContext, useContext, ReactNode, useMemo } from 'react';
import type { FrontendPluginRegistrar as SdkFrontendPluginRegistrar, FrontendPluginRegistration } from 'plugin-api';

export type UIExtensionSlotName = 
  | 'form:wrapper' 
  | 'form:header:actions' 
  | 'form:field:actions' 
  | 'form:group:actions' 
  | 'form:overlay'
  | 'designer:toolbar'
  | 'designer:toolbox'
  | 'designer:canvas'
  | 'designer:inspector';

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

export function FrontendPluginProvider({ children, plugins = [] }: { children: ReactNode, plugins?: readonly FrontendPluginRegistration[] }) {
  const [extensions, setExtensions] = React.useState<UIExtensionContribution[]>([]);
  const [customFields, setCustomFields] = React.useState<CustomFieldContribution[]>([]);
  const [renderers, setRenderers] = React.useState<Record<string, (props: any) => React.ReactNode>>({});

  React.useEffect(() => {
    let active = true;
    setExtensions([]);
    setCustomFields([]);
    setRenderers({});
    const registrar: FrontendPluginRegistrar = {
      registerExtension: (extension) => {
        if (active) setExtensions((current) => current.some((item) => item.pluginId === extension.pluginId && item.slot === extension.slot) ? current : [...current, extension]);
      },
      registerField: (field) => {
        if (active) setCustomFields((current) => current.some((item) => item.pluginId === field.pluginId && item.key === field.key) ? current : [...current, field]);
      },
      registerRenderer: (renderer) => {
        if (active) setRenderers((current) => current[renderer.uiElement] ? current : { ...current, [renderer.uiElement]: renderer.renderer });
      },
    };
    void Promise.all(plugins.map((plugin) => Promise.resolve(plugin(registrar as unknown as SdkFrontendPluginRegistrar)))).catch((error: unknown) => console.error('[PLUGIN] Frontend registration failed', error));
    return () => { active = false; };
  }, [plugins]);

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
