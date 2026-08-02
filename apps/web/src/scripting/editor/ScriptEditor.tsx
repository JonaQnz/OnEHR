import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  FormDefinitionV1,
  FormScriptConnectorOperationDefinition,
  FormScriptDiagnostic,
  FormScriptDocument,
} from 'core';
import {
  collectFormScriptSchemaIds,
  FORM_SCRIPTING_EXTENSION_KEY,
  FORM_FUNCTION_IMPORTS_EXTENSION_KEY,
  getFormFunctionImportConfiguration,
  getFormScriptConnectorConfiguration,
} from 'core';

const API = 'http://localhost:3001/api';

interface FormRecord {
  canonical_json: FormDefinitionV1;
  [key: string]: unknown;
}

interface FormScriptCompileResult {
  document: FormScriptDocument;
  valid: boolean;
}

interface FormScriptDiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
  oldLine?: number;
  newLine?: number;
}

interface FormScriptAiCandidate {
  candidateSource: string;
  valid: boolean;
  diagnostics: FormScriptDiagnostic[];
  generatedTypes: string;
  diff: FormScriptDiffLine[];
}

interface CompletionState {
  start: number;
  end: number;
  quote: '"' | "'";
  items: string[];
}
interface CodeFunction { id: string; packageName: string; name: string; description: string; }
interface AqlFunction { id: string; packageName: string; name: string; description: string; }

interface ScriptEditorProps {
  formId: string;
  definition: FormDefinitionV1;
  onSaved(record: FormRecord): void;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

function diagnosticLocation(diagnostic: FormScriptDiagnostic): string {
  return diagnostic.line
    ? `Zeile ${diagnostic.line}, Spalte ${diagnostic.column || 1}`
    : 'Form Script';
}

export default function ScriptEditor({ formId, definition, onSaved }: ScriptEditorProps) {
  const [source, setSource] = useState(definition.formScript.source);
  const [diagnostics, setDiagnostics] = useState<FormScriptDiagnostic[]>(definition.formScript.diagnostics);
  const [generatedTypes, setGeneratedTypes] = useState(definition.formScript.generatedTypes);
  const [showTypes, setShowTypes] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [status, setStatus] = useState('');
  const [statusError, setStatusError] = useState(false);
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiCandidate, setAiCandidate] = useState<FormScriptAiCandidate | null>(null);
  const [completion, setCompletion] = useState<CompletionState | null>(null);
  const [connectorOperations, setConnectorOperations] = useState<FormScriptConnectorOperationDefinition[]>([]);
  const [allowedOperations, setAllowedOperations] = useState(
    getFormScriptConnectorConfiguration(definition).allowedOperations,
  );
  const savedImports = getFormFunctionImportConfiguration(definition);
  const [codeFunctions, setCodeFunctions] = useState<CodeFunction[]>([]);
  const [aqlFunctions, setAqlFunctions] = useState<AqlFunction[]>([]);
  const [functionSearch, setFunctionSearch] = useState('');
  const [codePackages, setCodePackages] = useState(savedImports.codePackages);
  const [aqlFunctionIds, setAqlFunctionIds] = useState(savedImports.aqlFunctionIds);
  const checkSequence = useRef(0);
  const codeInput = useRef<HTMLTextAreaElement>(null);
  const savedAllowedOperations = getFormScriptConnectorConfiguration(definition).allowedOperations;
  const schemaIds = useMemo(() => collectFormScriptSchemaIds(definition), [definition.layout]);
  const dirty = source !== definition.formScript.source
    || JSON.stringify(allowedOperations) !== JSON.stringify(savedAllowedOperations)
    || JSON.stringify(codePackages) !== JSON.stringify(savedImports.codePackages)
    || JSON.stringify(aqlFunctionIds) !== JSON.stringify(savedImports.aqlFunctionIds);

  useEffect(() => {
    setSource(definition.formScript.source);
    setDiagnostics(definition.formScript.diagnostics);
    setGeneratedTypes(definition.formScript.generatedTypes);
    setAllowedOperations(getFormScriptConnectorConfiguration(definition).allowedOperations);
    const imports = getFormFunctionImportConfiguration(definition);
    setCodePackages(imports.codePackages);
    setAqlFunctionIds(imports.aqlFunctionIds);
    setAiCandidate(null);
    setCompletion(null);
  }, [definition.extensions, definition.formScript]);

  useEffect(() => {
    void fetch(`${API}/script-connectors`, { credentials: 'include' })
      .then(async (response) => {
        const body = await readJson(response);
        if (!response.ok) throw new Error(String(body.error || 'Connectoren konnten nicht geladen werden.'));
        setConnectorOperations(
          Array.isArray(body.operations)
            ? body.operations as unknown as FormScriptConnectorOperationDefinition[]
            : [],
        );
      })
      .catch((error: Error) => {
        setStatusError(true);
        setStatus(error.message);
      });
  }, []);

  useEffect(() => {
    void Promise.all([
      fetch(`${API}/functions/code`, { credentials: 'include' }),
      fetch(`${API}/functions/aql`, { credentials: 'include' }),
    ]).then(async ([codeResponse, aqlResponse]) => {
      const [codeBody, aqlBody] = await Promise.all([readJson(codeResponse), readJson(aqlResponse)]);
      if (!codeResponse.ok || !aqlResponse.ok) throw new Error('Function-Bibliothek konnte nicht geladen werden.');
      setCodeFunctions(Array.isArray(codeBody.functions) ? codeBody.functions as unknown as CodeFunction[] : []);
      setAqlFunctions(Array.isArray(aqlBody.functions) ? aqlBody.functions as unknown as AqlFunction[] : []);
    }).catch((error: Error) => { setStatusError(true); setStatus(error.message); });
  }, []);

  const errorCount = useMemo(
    () => diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length,
    [diagnostics],
  );

  const check = async (candidate = source, silent = false): Promise<boolean> => {
    const sequence = ++checkSequence.current;
    if (!silent) setChecking(true);
    try {
      const response = await fetch(`${API}/forms/${encodeURIComponent(formId)}/script/check`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: candidate, allowedOperations }),
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(String(body.error || `Prüfung fehlgeschlagen (${response.status})`));
      if (sequence !== checkSequence.current) return false;
      const result = body as unknown as FormScriptCompileResult;
      setDiagnostics(result.document.diagnostics);
      setGeneratedTypes(result.document.generatedTypes);
      if (!silent) {
        setStatusError(!result.valid);
        setStatus(result.valid ? 'TypeScript-Prüfung erfolgreich.' : 'Das Script enthält Fehler.');
      }
      return result.valid;
    } catch (error) {
      if (sequence === checkSequence.current && !silent) {
        setStatusError(true);
        setStatus(error instanceof Error ? error.message : 'TypeScript-Prüfung fehlgeschlagen.');
      }
      return false;
    } finally {
      if (!silent && sequence === checkSequence.current) setChecking(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void check(source, true);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [allowedOperations, source]);

  const save = async () => {
    setSaving(true);
    setStatusError(false);
    setStatus('');
    try {
      if (!(await check(source))) return;
      const response = await fetch(`${API}/forms/${encodeURIComponent(formId)}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...definition,
          extensions: {
            ...definition.extensions,
            [FORM_SCRIPTING_EXTENSION_KEY]: {
              allowedOperations,
            },
            [FORM_FUNCTION_IMPORTS_EXTENSION_KEY]: { codePackages, aqlFunctionIds },
          },
          formScript: {
            ...definition.formScript,
            source,
          },
        }),
      });
      const body = await readJson(response);
      if (!response.ok) {
        const messages = Array.isArray(body.messages)
          ? body.messages.map((item) => String((item as Record<string, unknown>).message || '')).filter(Boolean)
          : [];
        throw new Error(messages.join('\n') || String(body.error || `Speichern fehlgeschlagen (${response.status})`));
      }
      const record = body as FormRecord;
      onSaved(record);
      setDiagnostics(record.canonical_json.formScript.diagnostics);
      setGeneratedTypes(record.canonical_json.formScript.generatedTypes);
      setStatusError(false);
      setStatus('Form Script kompiliert und gemeinsam mit dem Formular gespeichert.');
    } catch (error) {
      setStatusError(true);
      setStatus(error instanceof Error ? error.message : 'Form Script konnte nicht gespeichert werden.');
    } finally {
      setSaving(false);
    }
  };

  const generate = async () => {
    if (!aiInstruction.trim()) {
      setStatusError(true);
      setStatus('Bitte zuerst eine Anweisung für die KI eingeben.');
      return;
    }
    setGenerating(true);
    setStatusError(false);
    setStatus('');
    setAiCandidate(null);
    try {
      const response = await fetch(`${API}/forms/${encodeURIComponent(formId)}/script/generate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: aiInstruction, source, allowedOperations }),
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(String(body.error || `KI-Codegenerierung fehlgeschlagen (${response.status})`));
      const candidate = body as unknown as FormScriptAiCandidate;
      setAiCandidate(candidate);
      setStatusError(!candidate.valid);
      setStatus(candidate.valid
        ? 'KI-Vorschlag wurde automatisch geprüft und ist kompilierbar.'
        : 'KI-Vorschlag wurde geprüft und enthält noch Fehler.');
    } catch (error) {
      setStatusError(true);
      setStatus(error instanceof Error ? error.message : 'KI-Codegenerierung ist fehlgeschlagen.');
    } finally {
      setGenerating(false);
    }
  };

  const acceptAiCandidate = () => {
    if (!aiCandidate) return;
    setSource(aiCandidate.candidateSource);
    setDiagnostics(aiCandidate.diagnostics);
    setGeneratedTypes(aiCandidate.generatedTypes);
    setAiCandidate(null);
    setCompletion(null);
    setStatusError(!aiCandidate.valid);
    setStatus(aiCandidate.valid
      ? 'KI-Vorschlag wurde in den sichtbaren TypeScript-Code übernommen. Zum Persistieren noch speichern.'
      : 'KI-Vorschlag wurde in den Editor übernommen und muss vor dem Speichern korrigiert werden.');
  };

  const updateCompletions = (element: HTMLTextAreaElement) => {
    const cursor = element.selectionStart;
    const beforeCursor = element.value.slice(0, cursor);
    const candidates: Array<{ pattern: RegExp; items: string[] }> = [
      { pattern: /(?:form\.field|ui\.field)\(\s*(["'])([^"']*)$/, items: schemaIds.fields },
      { pattern: /(?:form\.group|ui\.group)\(\s*(["'])([^"']*)$/, items: [...new Set([...schemaIds.groups, ...schemaIds.repeatableGroups])] },
      { pattern: /ui\.section\(\s*(["'])([^"']*)$/, items: schemaIds.sections },
      { pattern: /ui\.tab\(\s*(["'])([^"']*)$/, items: schemaIds.tabs },
      { pattern: /ui\.button\(\s*(["'])([^"']*)$/, items: schemaIds.buttons },
      { pattern: /ui\.text\(\s*(["'])([^"']*)$/, items: schemaIds.texts },
      { pattern: /ui\.alert\(\s*(["'])([^"']*)$/, items: schemaIds.alerts },
      { pattern: /api\.call\(\s*(["'])([^"']*)$/, items: allowedOperations },
    ];
    for (const candidate of candidates) {
      const match = beforeCursor.match(candidate.pattern);
      if (!match) continue;
      const prefix = match[2];
      const items = candidate.items.filter((item) => item.toLowerCase().includes(prefix.toLowerCase()));
      setCompletion(items.length > 0
        ? {
          start: cursor - prefix.length,
          end: cursor,
          quote: match[1] as '"' | "'",
          items: items.slice(0, 12),
        }
        : null);
      return;
    }
    setCompletion(null);
  };

  const insertCompletion = (item: string) => {
    if (!completion) return;
    const suffix = source[completion.end] === completion.quote ? '' : completion.quote;
    const nextSource = `${source.slice(0, completion.start)}${item}${suffix}${source.slice(completion.end)}`;
    const cursor = completion.start + item.length + suffix.length;
    setSource(nextSource);
    setAiCandidate(null);
    setCompletion(null);
    window.requestAnimationFrame(() => {
      codeInput.current?.focus();
      codeInput.current?.setSelectionRange(cursor, cursor);
    });
  };

  const insertSnippet = (snippet: string) => {
    const element = codeInput.current;
    const start = element?.selectionStart ?? source.length;
    const end = element?.selectionEnd ?? start;
    const prefix = start > 0 && !source.slice(0, start).endsWith('\n') ? '\n' : '';
    const next = `${source.slice(0, start)}${prefix}${snippet}${source.slice(end)}`;
    setSource(next);
    window.requestAnimationFrame(() => { codeInput.current?.focus(); const cursor = start + prefix.length + snippet.length; codeInput.current?.setSelectionRange(cursor, cursor); });
  };
  const filteredCode = codeFunctions.filter((item) => `${item.packageName} ${item.name} ${item.description}`.toLowerCase().includes(functionSearch.toLowerCase()));
  const filteredAql = aqlFunctions.filter((item) => `${item.packageName} ${item.name} ${item.description}`.toLowerCase().includes(functionSearch.toLowerCase()));
  const codePackageNames = [...new Set(codeFunctions.map((item) => item.packageName))].sort();

  return (
    <section className="script-editor-shell" aria-label="TypeScript Form Script">
      <div className="script-editor-toolbar">
        <div>
          <strong>form-script.ts</strong>
          <span className={`script-status-badge ${errorCount > 0 ? 'error' : dirty ? 'dirty' : 'valid'}`}>
            {errorCount > 0 ? `${errorCount} Fehler` : dirty ? 'Ungespeichert' : 'Kompiliert'}
          </span>
        </div>
        <div className="script-editor-actions">
          <button type="button" className="btn-workbench secondary" onClick={() => setShowTypes((value) => !value)}>
            {showTypes ? 'Typen ausblenden' : 'Generierte Typen'}
          </button>
          <button type="button" className="btn-workbench secondary" disabled={checking} onClick={() => void check()}>
            {checking ? 'Prüft…' : 'TypeScript prüfen'}
          </button>
          <button type="button" className="btn-workbench success" disabled={saving || errorCount > 0} onClick={() => void save()}>
            {saving ? 'Kompiliert…' : 'Speichern & kompilieren'}
          </button>
        </div>
      </div>

      <details className="script-connectors">
        <summary>Freigegebene API-Connectoren ({allowedOperations.length})</summary>
        <p>Nur ausgewählte Operationen sind für dieses Formular typisiert und serverseitig ausführbar.</p>
        <div className="script-connector-list">
          {connectorOperations.length === 0
            ? <span className="script-diagnostic-empty">Keine Connector-Operationen verfügbar.</span>
            : connectorOperations.map((operation) => (
              <label className="script-connector-option" key={operation.id}>
                <input
                  type="checkbox"
                  checked={allowedOperations.includes(operation.id)}
                  onChange={(event) => {
                    setAllowedOperations((current) => (
                      event.target.checked
                        ? [...new Set([...current, operation.id])].sort()
                        : current.filter((id) => id !== operation.id)
                    ));
                    setAiCandidate(null);
                  }}
                />
                <span>
                  <strong>{operation.label}</strong>
                  <code>{operation.id}</code>
                  {operation.description && <small>{operation.description}</small>}
                  {operation.permissions.length > 0 && <small>Scopes: {operation.permissions.join(', ')}</small>}
                </span>
              </label>
            ))}
        </div>
      </details>

      <details className="script-connectors" open>
        <summary>Functions & AQL importieren ({codePackages.length} Pakete · {aqlFunctionIds.length} AQLs)</summary>
        <p>Code-Pakete werden im isolierten Form-Script-Worker verfügbar. Ausgewählte AQLs werden beim Start dieser Form-Session serverseitig ausgeführt und als Kontext bereitgestellt.</p>
        <input
          className="script-ai-instruction"
          aria-label="Functions und AQLs durchsuchen"
          value={functionSearch}
          onChange={(event) => setFunctionSearch(event.target.value)}
          placeholder="Packages, Functions oder AQLs suchen …"
          style={{ minHeight: 0, marginBottom: '0.65rem' }}
        />
        <div className="script-connector-list">
          <strong style={{ gridColumn: '1 / -1' }}>Code-Pakete</strong>
          {codePackageNames.filter((packageName) => packageName.toLowerCase().includes(functionSearch.toLowerCase()) || filteredCode.some((item) => item.packageName === packageName)).map((packageName) => {
            const functions = filteredCode.filter((item) => item.packageName === packageName);
            const selected = codePackages.includes(packageName);
            return <label className="script-connector-option" key={packageName}>
              <input type="checkbox" checked={selected} onChange={(event) => setCodePackages((current) => event.target.checked ? [...new Set([...current, packageName])].sort() : current.filter((item) => item !== packageName))} />
              <span><strong>{packageName}</strong><code>functions.{packageName}.*</code><small>{functions.map((item) => item.name).join(', ')}</small>{selected && functions.map((item) => <button key={item.id} type="button" className="btn-workbench secondary" onClick={() => insertSnippet(`functions.${item.packageName}.${item.name}({});`)} style={{ margin: '0.25rem 0.35rem 0 0', padding: '0.2rem 0.45rem', fontSize: '0.72rem' }}>+ {item.name}</button>)}</span>
            </label>;
          })}
          <strong style={{ gridColumn: '1 / -1', marginTop: '0.45rem' }}>AQL-Kontext</strong>
          {filteredAql.map((item) => {
            const selected = aqlFunctionIds.includes(item.id);
            return <label className="script-connector-option" key={item.id}>
              <input type="checkbox" checked={selected} onChange={(event) => setAqlFunctionIds((current) => event.target.checked ? [...new Set([...current, item.id])].sort() : current.filter((id) => id !== item.id))} />
              <span><strong>{item.packageName}.{item.name}</strong><code>context.aql['{item.packageName}.{item.name}']</code><small>{item.description}</small>{selected && <button type="button" className="btn-workbench secondary" onClick={() => insertSnippet(`const ${item.name} = context.aql['${item.packageName}.${item.name}'];`)} style={{ marginTop: '0.25rem', padding: '0.2rem 0.45rem', fontSize: '0.72rem' }}>+ Kontext-Code</button>}</span>
            </label>;
          })}
        </div>
      </details>

      <section className="script-ai-panel" aria-label="KI-Codegenerierung">
        <div className="script-ai-heading">
          <div>
            <strong>KI-Codevorschlag</strong>
            <span>Anweisung, Formularschema, Typen und aktueller Code werden an den konfigurierten Provider gesendet. Änderungen werden erst nach deiner Bestätigung übernommen.</span>
          </div>
          <button
            type="button"
            className="btn-workbench secondary"
            disabled={generating || !aiInstruction.trim()}
            onClick={() => void generate()}
          >
            {generating ? 'Generiert & prüft…' : 'Vorschlag generieren'}
          </button>
        </div>
        <textarea
          className="script-ai-instruction"
          aria-label="Anweisung für KI-Codegenerierung"
          value={aiInstruction}
          disabled={generating}
          placeholder="z. B. Wenn smokingStatus auf current gesetzt wird, zeige smokingDetails an und mache cigarettesPerDay zum Pflichtfeld."
          onChange={(event) => setAiInstruction(event.target.value)}
        />
      </section>

      {aiCandidate && (
        <section className="script-ai-review" aria-label="Diff des KI-Codevorschlags">
          <div className="script-ai-review-toolbar">
            <div>
              <strong>Diff prüfen</strong>
              <span className={`script-status-badge ${aiCandidate.valid ? 'valid' : 'error'}`}>
                {aiCandidate.valid
                  ? 'Automatische Prüfung erfolgreich'
                  : `${aiCandidate.diagnostics.filter((item) => item.severity === 'error').length} Fehler`}
              </span>
            </div>
            <div>
              <button type="button" className="btn-workbench secondary" onClick={() => setAiCandidate(null)}>
                Verwerfen
              </button>
              <button type="button" className="btn-workbench success" onClick={acceptAiCandidate}>
                In form-script.ts übernehmen
              </button>
            </div>
          </div>
          <div className="script-ai-diff">
            {aiCandidate.diff.map((line, index) => (
              <div className={`script-ai-diff-line ${line.kind}`} key={`${line.kind}:${line.oldLine}:${line.newLine}:${index}`}>
                <span>{line.oldLine || ''}</span>
                <span>{line.newLine || ''}</span>
                <code>{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}{line.text}</code>
              </div>
            ))}
          </div>
          {!aiCandidate.valid && (
            <div className="script-ai-candidate-diagnostics">
              {aiCandidate.diagnostics.map((diagnostic, index) => (
                <div className={`script-diagnostic ${diagnostic.severity}`} key={`${diagnostic.code}:${index}`}>
                  <strong>{diagnosticLocation(diagnostic)}</strong>
                  <span>{diagnostic.message}</span>
                  <code>{diagnostic.code}</code>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <div className={`script-editor-grid ${showTypes ? 'with-types' : ''}`}>
        <textarea
          ref={codeInput}
          aria-label="form-script.ts"
          className="script-code-input"
          value={source}
          spellCheck={false}
          onChange={(event) => {
            setSource(event.target.value);
            setAiCandidate(null);
            updateCompletions(event.target);
          }}
          onClick={(event) => updateCompletions(event.currentTarget)}
          onKeyUp={(event) => {
            if (event.key !== 'Escape') updateCompletions(event.currentTarget);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setCompletion(null);
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
              event.preventDefault();
              void save();
            }
          }}
        />
        {showTypes && <pre className="script-generated-types" aria-label="Generierte TypeScript-Typen">{generatedTypes}</pre>}
      </div>

      {completion && (
        <div className="script-completions" role="listbox" aria-label="Autocomplete für Formular-IDs">
          <span>Passende IDs</span>
          {completion.items.map((item) => (
            <button type="button" role="option" key={item} onMouseDown={(event) => event.preventDefault()} onClick={() => insertCompletion(item)}>
              {item}
            </button>
          ))}
        </div>
      )}

      {status && <div className={`script-editor-status ${statusError ? 'error' : ''}`}>{status}</div>}
      <div className="script-diagnostics" aria-live="polite">
        {diagnostics.length === 0
          ? <div className="script-diagnostic-empty">Keine TypeScript- oder Sicherheitsfehler.</div>
          : diagnostics.map((diagnostic, index) => (
            <div className={`script-diagnostic ${diagnostic.severity}`} key={`${diagnostic.code}:${diagnostic.line}:${diagnostic.column}:${index}`}>
              <strong>{diagnosticLocation(diagnostic)}</strong>
              <span>{diagnostic.message}</span>
              <code>{diagnostic.code}</code>
            </div>
          ))}
      </div>
    </section>
  );
}
