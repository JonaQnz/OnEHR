# Integrierte Form-Scripting-Engine

## Technische Integration

Die Scripting-Engine ist eine Core-Funktion und kein Plugin. Das Script liegt als
`formScript` direkt in der kanonischen `FormDefinitionV1`. Dadurch werden
Formularschema, TypeScript-Quelle, generierte Typen und kompiliertes JavaScript
immer gemeinsam gespeichert, kopiert und veröffentlicht.

Die bestehenden Integrationspunkte bleiben erhalten:

- `packages/core` definiert Datenmodell, Runtime-Validierung, öffentliche SDK und
  formularspezifische TypeScript-Deklarationen.
- `apps/api` prüft und kompiliert das Script beim Speichern und Veröffentlichen.
  Die bestehenden Plugin-Hooks werden nicht ersetzt.
- `apps/web/src/components/FormRuntime.tsx` bleibt der zentrale Preview- und
  Live-Runtime-Pfad. Dort läuft das Script isoliert in einem Web Worker.
- `apps/web/src/pages/FormBuilder.tsx` stellt Designer, Preview, TypeScript und
  Logs bereit.
- `apps/web/src/pages/SessionRuntime.tsx` nutzt weiterhin die vorhandenen
  Load-/Save-/Submit-Endpunkte. Die gleichnamigen Script-Hooks sind an diesen
  Ablauf gekoppelt.

## Datenmodell

```ts
interface FormDefinitionV1 {
  // bestehende FormDefinition-Felder
  formScript: {
    language: "typescript";
    source: string;
    compiled: string;
    generatedTypes: string;
    diagnostics: FormScriptDiagnostic[];
    compiledAt?: string;
  };
}
```

Alte Formulare werden beim Lesen um ein leeres Script ergänzt. Eine
Datenbankmigration ist nicht nötig, weil die FormDefinition atomar in
`canonical_json` gespeichert und versioniert wird.

## Runtime-API

```ts
defineFormScript(({ form, ui, events, logger, context, state, api }) => {
  form.field("weight").setValue(82);
  form.field("weight").onChange(handler);
  form.field("weight").validate(async (value, { form }) => null);
  form.updateValues({ weight: 82, height: 180 });

  form.computed("bmi", {
    dependsOn: ["weight", "height"],
    persist: true,
    calculate: ({ weight, height }) => (
      weight && height ? weight / Math.pow(height / 100, 2) : null
    ),
  });

  const medication = form.group("medication");
  medication.addItem({ substance: "Metoprolol", dose: 50 });
  medication.removeItem(0);
  medication.replaceItems([]);
  medication.onAddItem(handler);
  medication.onRemoveItem(handler);
  medication.onItemChange(handler);

  ui.field("diagnosis").setState({
    visible: true,
    enabled: true,
    readonly: false,
    required: true,
  });
  ui.field("diagnosis").setLabel("Hauptdiagnose");
  ui.field("diagnosis").setHelpText("Bitte führende Diagnose auswählen.");
  ui.field("diagnosis").setOptions([
    { value: "a", label: "Diagnose A" },
  ]);
  ui.button("load").onClick(handler);

  events.beforeLoad(handler);
  events.afterLoad(handler);
  events.beforeSave(handler);
  events.afterSave(handler);
  events.beforeSubmit(handler);
  events.afterSubmit(handler);
  events.onInit(handler);
  events.onReset(handler);
  events.onValidation(handler);
  events.onDestroy(handler);

  state.set("temporary", value);
  const patient = await api.call(
    "patient.get",
    { id: context.patientId },
  );
  logger.info("Formular geladen");
});
```

## Laufzeitverhalten

- `form.updateValues` übernimmt alle Werte zuerst und verarbeitet danach die
  Change-Events als einen Batch.
- Berechnete Felder besitzen explizite Abhängigkeiten. Die Runtime führt nur
  betroffene Berechnungen erneut aus, erkennt Zyklen und protokolliert Laufzeit
  sowie Persistenzstatus.
- Werte mit `persist: false` bleiben im Worker und Renderer verfügbar, werden
  aber aus Save-/Submit-Werten entfernt.
- Feldvalidatoren dürfen synchron oder asynchron sein. Fehler werden am
  betreffenden Feld angezeigt und blockieren den Submit.
- Wiederholbare Gruppen werden als typisierte Zeilenobjekte gespeichert,
  gerendert und zeilenweise validiert.
- Der Loop-Schutz ignoriert unveränderte Werte, begrenzt eine Transaktion auf
  100 Änderungen und stoppt wiederholte identische Änderungen.
- Handlerfehler bleiben isoliert und erscheinen mit Event, Komponenten-ID und
  Laufzeit im Logs-Bereich.
- API-Aufrufe verlassen den Worker ausschließlich als strukturierte
  Connector-Nachrichten. Der Browser-Host ruft den authentifizierten
  Backend-Proxy auf; Formularscripts erhalten weder URL noch Zugangsdaten.
- Jede Operation benötigt eine Formular-Allowlist, ein Ein-/Ausgabe-Schema und
  serverseitige Permission-Scopes. Die öffentlichen Schemata werden gemeinsam
  mit der Formularversion gespeichert und in konkrete TypeScript-Typen
  übersetzt.
- `onChange` unterstützt `debounce` und `cancelPrevious`. Das Event-Signal wird
  bis zum HTTP-Request weitergereicht; ältere Requests werden abgebrochen.
- API-Aufrufe aus Button-Handlern setzen den vorhandenen Button-Loading-State
  automatisch. Start, Ende, Fehler und Laufzeit erscheinen im Script-Log.
- Plugins registrieren Connector-Operationen über den Extension Point
  `scripting`; die Handler laufen weiterhin als isolierte Plugin-Actions und
  dürfen nur im Manifest deklarierte Permissions verwenden.

Direkter Netzwerkzugriff aus dem Formularscript bleibt gesperrt. Neue
Connectoren werden ausschließlich serverseitig registriert.

## KI-Codegenerierung und Autocomplete

Der TypeScript-Editor schlägt beim Schreiben in `form.field(...)`,
`ui.field(...)`, `ui.group(...)`, `ui.section(...)`, `ui.tab(...)`,
`ui.button(...)`, `ui.text(...)`, `ui.alert(...)` und `api.call(...)` nur IDs
vor, die im aktuellen Formularschema beziehungsweise in der aktuellen
Connector-Allowlist existieren.

Eine KI-Anweisung wird über den authentifizierten Endpunkt
`POST /api/forms/:id/script/generate` verarbeitet. Das Backend stellt dafür
einen Prompt aus folgenden, bereits versionsgebundenen Informationen zusammen:

- kanonisches Formularschema mit Layout, Bindings und Labels,
- generierte Runtime- und Formular-Typen,
- aktueller sichtbarer Inhalt von `form-script.ts`,
- aktuelle Compilerdiagnosen,
- freigegebene Connector-IDs und deren Ein-/Ausgabeschemata.

Der Provider liefert ausschließlich einen vollständigen TypeScript-Quelltext.
Das Backend entfernt optionale Markdown-Codeblöcke, begrenzt die Größe und
kompiliert den Vorschlag mit demselben TypeScript- und Security-Compiler wie
beim Speichern. Auch fehlerhafte Vorschläge werden nicht ausgeführt, sondern
mit ihren Diagnosen als Review zurückgegeben.

Im Browser bleibt der vorhandene Quelltext unverändert, bis der Benutzer den
Zeilen-Diff explizit mit **In form-script.ts übernehmen** bestätigt. Verwerfen
löscht nur den flüchtigen Vorschlag. Nach dem Übernehmen ist wieder ausschließlich
der sichtbare und editierbare TypeScript-Code die Source of Truth; eine zweite
Regelrepräsentation wird weder gespeichert noch ausgeführt.

### Provider-Konfiguration

Unter **System Settings → Form Script AI** werden Base URL und Modell eines
OpenAI-kompatiblen Chat-Completions-Providers konfiguriert:

```text
FORM_SCRIPT_AI_BASE_URL=https://api.example.com/v1
FORM_SCRIPT_AI_MODEL=provider-model-id
FORM_SCRIPT_AI_API_KEY=server-only-secret
```

Alternativ wird für den Key `OPENAI_API_KEY` gelesen. Der Key stammt
ausschließlich aus der Serverumgebung beziehungsweise einem Secret Store. Er
wird nicht in `config.json` persistiert, in der Config-API nur maskiert und nie
an das Web-Frontend oder ein Formularscript ausgeliefert. Base URL und Modell
können in der Admin-Oberfläche gespeichert werden; Änderungen am System-Setup
sind authentifiziert.

KI-Anfragen sind auf zehn Aufrufe pro Benutzer und Formular je Minute begrenzt,
haben ein serverseitiges Timeout und werden bei Abbruch des HTTP-Requests
abgebrochen. Das Audit-Log enthält nur Formular-ID, Benutzer-ID, Laufzeit,
Status und Fehlercode – weder Prompt noch Quelltext oder Zugangsdaten.

## Implementierungsstand

1. Phase 1: Datenmodell, Editor, Compiler, Worker, Lifecycle, Werte, UI und Logs.
2. Phase 2: Computed Fields, Validatoren, dynamische Texte/Optionen,
   wiederholbare Gruppen, Session State, Batching und Loop-Schutz.
3. Phase 3: Connector Registry, serverseitiger Proxy, typisierte Operationen,
   Berechtigungen, Loading, Debouncing und Request-Abbruch.
4. Phase 4: generierte Formular-Typen, ID-Autocomplete, typisierte Connectoren,
   serverseitige KI-Codegenerierung, Diff-Review und automatische Prüfung.
