import { PluginActivationContext, PluginManifest } from 'plugin-api';

export const manifest: PluginManifest = {
  id: 'formbuilder-plugin-iframe',
  version: '1.0.0',
  apiVersion: '1.0',
  name: 'Iframe Field Plugin',
  description: 'Provides a custom Iframe field for the form builder.',
  extensionPoints: ['field', 'renderer'],
  permissions: ['form:read']
};

export function activate(context: PluginActivationContext) {
  context.requirePermission('form:read');

  // Register the Field Contribution
  context.registerFieldType({
    key: 'org.openehr.iframe.field',
    fieldType: 'IframeField',
    label: 'Iframe',
    propertySchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          title: 'Iframe URL',
          description: 'The URL to embed.'
        },
        height: {
          type: 'string',
          title: 'Iframe Height',
          default: '400px'
        },
        border: {
          type: 'boolean',
          title: 'Show Border',
          default: true
        }
      }
    }
  });

  // Register Renderer metadata
  context.registerRenderer({
    key: 'org.openehr.iframe.renderer',
    rendererId: 'IframeRenderer',
    fieldTypes: ['IframeField']
  });

  console.log('✅ [formbuilder-plugin-iframe] Plugin activated');
}
