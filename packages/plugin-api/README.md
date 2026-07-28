# Form Builder Plugin API

The package defines the public TypeScript contract for self-hosted Form Builder plugins. Plugins are ordinary npm packages; they do not need a proprietary code or data format.

## Minimal plugin

```ts
import type { FormBuilderPlugin } from 'plugin-api';

const plugin: FormBuilderPlugin = {
  manifest: {
    id: 'org.example.vitals',
    version: '1.0.0',
    apiVersion: '1.0',
    name: 'Vitals',
    extensionPoints: ['field', 'settings', 'lifecycle'],
    permissions: ['form:read'],
  },
  activate(context) {
    context.registerFieldType({
      key: 'vitals.quantity',
      fieldType: 'quantity',
      label: 'Vital quantity',
      propertySchema: { type: 'object' },
    });
    context.registerSettingsPanel({
      key: 'vitals.settings',
      panelId: 'vitals.settings',
      label: 'Vitals settings',
    });
    context.registerHook('beforeFormSave', ({ data }) => ({
      data: { ...data, 'org.example.vitals': { checked: true } },
    }));
  },
};

export default plugin;
```

## Extension points

- `field`: field type and field-property contributions.
- `settings`: settings panels and configuration schemas.
- `form`: form toolbar, footer, and context actions.
- `renderer`: renderer registrations for field types.
- `designer`: panels in the form designer workspace.
- `runtime`: actions while filling a form.
- `dataProvider`: declarative load/submit provider contributions.
- `workflow`: named workflow triggers that can be connected to n8n or another engine.
- `lifecycle`: deterministic hooks before/after load, save, and submit.

The API exposes only serializable manifests and contribution descriptors through `GET /api/plugins`. Executable plugin code stays inside the trusted self-hosted server process. User-provided scripts are a separate sandboxed execution feature and are not implicitly trusted as npm plugins.

## Loading

Configure comma-separated npm package names in `FORM_BUILDER_PLUGINS`, for example:

```text
FORM_BUILDER_PLUGINS=@acme/formbuilder-vitals,@acme/formbuilder-signature
```

The self-hosted application also exposes a Plugins page and the `POST /api/plugins/load` and `POST /api/plugins/unload` endpoints. Entering a package name there persists it in the application configuration and loads it into the server. The package must already be installed in the deployment (for example as a workspace dependency or in the Docker image); the browser never installs or executes arbitrary code.

`GET /api/plugins` returns the current manifests, package status, and serializable contributions so an administrator can inspect what is active.

The manifest schema is available at `schemas/plugin-manifest-v1.schema.json`.
Settings, runtime, and form contributions may register a server-side handler with `context.registerAction(actionId, handler)`. The host exposes it through `POST /api/plugins/actions/:pluginId/:actionId` and passes form, patient, session, and metadata context. Plugins must enforce their declared permissions inside the handler.
The example n8n plugin contributes a form-settings action. Configure `N8N_API_URL`, `N8N_API_KEY`, `N8N_PUBLIC_URL`, and `N8N_EHRBASE_URL`, load `formbuilder-example-n8n-plugin`, open a form's `Submission` settings, and click `Als n8n Form konfigurieren`. The plugin creates or updates a workflow (`Webhook → EHRbase lookup → EHRbase composition`) and stores only the neutral workflow reference in the form definition. Form runtime submissions then POST the complete `formbuilder.form-submission.v1` payload to that webhook.
