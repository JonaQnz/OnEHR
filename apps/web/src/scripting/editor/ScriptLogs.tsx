import { useEffect, useMemo, useState } from 'react';
import type { FormScriptLogEntry } from 'core';
import {
  clearScriptLogs,
  getScriptLogs,
  subscribeScriptLogs,
} from '../runtime/scriptLogStore';

interface ScriptLogsProps {
  formId: string;
}

export default function ScriptLogs({ formId }: ScriptLogsProps) {
  const [entries, setEntries] = useState<FormScriptLogEntry[]>(() => getScriptLogs(formId));
  const [level, setLevel] = useState<'all' | FormScriptLogEntry['level']>('all');

  useEffect(() => subscribeScriptLogs(formId, setEntries), [formId]);

  const visibleEntries = useMemo(
    () => entries.filter((entry) => level === 'all' || entry.level === level).reverse(),
    [entries, level],
  );

  return (
    <section className="script-logs-shell" aria-label="Form Script Logs">
      <div className="script-editor-toolbar">
        <div>
          <strong>Runtime Logs</strong>
          <span className="script-status-badge valid">{entries.length} Einträge</span>
        </div>
        <div className="script-editor-actions">
          <select className="form-input" value={level} onChange={(event) => setLevel(event.target.value as typeof level)} aria-label="Log-Level">
            <option value="all">Alle Level</option>
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warnung</option>
            <option value="error">Fehler</option>
          </select>
          <button type="button" className="btn-workbench secondary" onClick={() => clearScriptLogs(formId)}>Logs leeren</button>
        </div>
      </div>
      {visibleEntries.length === 0
        ? <div className="script-log-empty">Noch keine Runtime-Ereignisse. Öffne die Preview und interagiere mit dem Formular.</div>
        : <div className="script-log-list">{visibleEntries.map((entry) => (
          <article className={`script-log-entry ${entry.level}`} key={entry.id}>
            <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString()}</time>
            <span className="script-log-level">{entry.level.toUpperCase()}</span>
            <span className="script-log-event">{entry.event || 'runtime'}{entry.componentId ? ` · ${entry.componentId}` : ''}</span>
            <span className="script-log-message">{entry.message}</span>
            {entry.durationMs !== undefined && <span className="script-log-duration">{entry.durationMs} ms</span>}
            {entry.error && <pre>{entry.error}</pre>}
          </article>
        ))}</div>}
    </section>
  );
}
