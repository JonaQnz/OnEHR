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

interface PluginRegistryContextType {
  extensions: UIExtensionContribution[];
  registerExtension: (extension: UIExtensionContribution) => void;
}

const PluginRegistryContext = createContext<PluginRegistryContextType>({ 
  extensions: [], 
  registerExtension: () => {} 
});

export function FrontendPluginProvider({ children, plugins = [] }: { children: ReactNode, plugins?: Array<(register: (ext: UIExtensionContribution) => void) => void> }) {
  const [extensions, setExtensions] = React.useState<UIExtensionContribution[]>([]);

  React.useEffect(() => {
    let mounted = true;
    const registry = (ext: UIExtensionContribution) => {
      if (!mounted) return;
      setExtensions((prev) => {
        // Verhindert doppelte UI-Komponenten im React 18 StrictMode (Mount -> Unmount -> Mount)
        if (prev.some(p => p.pluginId === ext.pluginId && p.slot === ext.slot)) {
          return prev;
        }
        return [...prev, ext];
      });
    };
    
    plugins.forEach(pluginInit => pluginInit(registry));

    return () => {
      mounted = false;
    };
  }, [plugins]);

  return (
    <PluginRegistryContext.Provider value={{ extensions, registerExtension: (ext) => setExtensions(p => [...p, ext]) }}>
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
