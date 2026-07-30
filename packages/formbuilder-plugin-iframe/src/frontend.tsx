import React from 'react';

interface FrontendPluginRegistrar {
  registerExtension: (extension: any) => void;
  registerField: (field: any) => void;
  registerRenderer: (renderer: any) => void;
}

const IframeDesignerPreview = React.forwardRef((props: any, ref: any) => {
  console.log('[IframeDesignerPreview] Rendering with props:', props);
  const height = props.height || '400px';
  const border = props.border !== false;
  return (
    <div ref={ref} style={{
      width: '100%',
      height,
      border: border ? '1px solid #ccc' : 'none',
      background: '#f8f9fa',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#6c757d',
      minHeight: '100px'
    }}>
      {props.url ? `Iframe: ${props.url}` : 'Iframe Placeholder (Configure URL)'}
    </div>
  );
});

const IframeRuntimeRenderer = (props: any) => {
  const { node } = props;
  const iframeProps = node.props || {};
  let rawUrl = iframeProps.url || node.url;
  if (rawUrl && !rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
    rawUrl = `https://${rawUrl}`;
  }
  
  const [url, setUrl] = React.useState(rawUrl);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setUrl(rawUrl);
    }, 800); // Wait 800ms after last keystroke before updating iframe
    return () => clearTimeout(timer);
  }, [rawUrl]);

  const height = iframeProps.height || node.height || '400px';
  const border = (iframeProps.border !== undefined ? iframeProps.border : node.border) !== false;
  
  if (!url) {
    return (
      <div style={{ width: '100%', padding: '1rem', background: '#ffebee', color: '#c62828' }}>
        Iframe error: No URL configured.
      </div>
    );
  }

  return (
    <iframe
      src={url}
      style={{
        width: '100%',
        height,
        border: border ? '1px solid #ccc' : 'none',
        marginBottom: '1rem',
        marginTop: '1rem'
      }}
      title="Embedded Content"
      allow="fullscreen"
    />
  );
};

export function registerFrontendPlugin(register: FrontendPluginRegistrar) {
  
  // Register the Field for the FormBuilder Designer Toolbox
  register.registerField({
    pluginId: 'formbuilder-plugin-iframe',
    key: 'IframeField',
    component: IframeDesignerPreview,
    toolboxItem: {
      element: 'CustomElement',
      name: 'Iframe',
      icon: 'fas fa-window-maximize',
      label: 'Iframe',
      static: true,
      type: 'custom',
      forwardRef: true,
      field_name: 'iframe_',
      hideDefaultProperties: true,
      custom_metadata: {
        type: 'IframeField'
      }
    }
  });

  // Register the Renderer for FormRuntime
  register.registerRenderer({
    pluginId: 'formbuilder-plugin-iframe',
    uiElement: 'IframeField',
    renderer: IframeRuntimeRenderer
  });

}
