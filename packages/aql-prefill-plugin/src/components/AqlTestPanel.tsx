import React, { useState } from 'react';
import { AqlPrefillConfiguration, PrefillRuntimeContext } from '../types/aqlPrefill';
import { AqlClient } from '../services/aqlClient';
import { buildAqlQuery, resolveAqlParameters } from '../utils/queryBuilder';
import { normalizeEhrbaseAqlResponse } from '../services/ehrbaseAqlAdapter';
import { resolveResultPath } from '../services/resultPathResolver';

export interface AqlTestPanelProps {
  config: AqlPrefillConfiguration;
  testContext?: PrefillRuntimeContext;
}

export function AqlTestPanel({ config, testContext }: AqlTestPanelProps) {
  const [running, setRunning] = useState(false);
  const [ehrId, setEhrId] = useState(testContext?.ehrId || '');
  const [compositionId, setCompositionId] = useState(testContext?.compositionId || '');
  const [patientId, setPatientId] = useState(testContext?.patientId || '');

  const [testResult, setTestResult] = useState<{
    query: string;
    parameters: Record<string, unknown>;
    status: number;
    rawResult: unknown;
    normalizedValues: Record<string, unknown>;
    mappedFields: Array<{ mappingId: string; resultPath: string; fieldId: string; value: unknown }>;
    unmappedColumns: string[];
    missingTargets: string[];
    error?: string;
  } | null>(null);

  const runTestQuery = async () => {
    setRunning(true);
    setTestResult(null);

    const activeContext: PrefillRuntimeContext = {
      ...(testContext || {}),
      ehrId: ehrId || testContext?.ehrId,
      compositionId: compositionId || testContext?.compositionId,
      patientId: patientId || testContext?.patientId,
    };

    const query = buildAqlQuery(config);
    const parameters = resolveAqlParameters(config.parameters || [], activeContext);

    try {
      const client = new AqlClient();
      const rawResult = await client.executeQuery({ query, parameters });
      const normalizedRows = normalizeEhrbaseAqlResponse(rawResult);
      const firstRow = normalizedRows[0] || {};

      const mappedFields: Array<{ mappingId: string; resultPath: string; fieldId: string; value: unknown }> = [];
      const normalizedValues: Record<string, unknown> = {};
      const missingTargets: string[] = [];

      for (const mapping of config.mappings || []) {
        const val = resolveResultPath(firstRow, mapping.resultPath);
        normalizedValues[mapping.id] = val;
        if (val !== undefined && val !== null) {
          mappedFields.push({
            mappingId: mapping.id,
            resultPath: mapping.resultPath,
            fieldId: mapping.target.fieldId,
            value: val,
          });
        } else {
          missingTargets.push(`${mapping.target.fieldId} (${mapping.resultPath})`);
        }
      }

      const allRowKeys = Object.keys(firstRow);
      const mappedPaths = new Set((config.mappings || []).map((m) => m.resultPath));
      const unmappedColumns = allRowKeys.filter((key) => !mappedPaths.has(key));

      setTestResult({
        query,
        parameters,
        status: 200,
        rawResult,
        normalizedValues,
        mappedFields,
        unmappedColumns,
        missingTargets,
      });
    } catch (error) {
      setTestResult({
        query,
        parameters,
        status: 500,
        rawResult: null,
        normalizedValues: {},
        mappedFields: [],
        unmappedColumns: [],
        missingTargets: [],
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ marginTop: '1rem', padding: '1rem', border: '1px solid #cbd5e1', borderRadius: '8px', background: '#f8fafc' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <h4 style={{ margin: 0, fontSize: '0.9rem', color: '#1e293b' }}>Testabfrage</h4>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.7rem', color: '#64748b', fontWeight: 600 }}>Test EHR-ID</label>
            <input
              type="text"
              value={ehrId}
              onChange={(e) => setEhrId(e.target.value)}
              placeholder="e.g. ehr-123"
              style={{ width: '100%', padding: '0.3rem', fontSize: '0.75rem', borderRadius: '4px', border: '1px solid #cbd5e1', boxSizing: 'border-box' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.7rem', color: '#64748b', fontWeight: 600 }}>Test Composition-ID</label>
            <input
              type="text"
              value={compositionId}
              onChange={(e) => setCompositionId(e.target.value)}
              placeholder="e.g. comp-456"
              style={{ width: '100%', padding: '0.3rem', fontSize: '0.75rem', borderRadius: '4px', border: '1px solid #cbd5e1', boxSizing: 'border-box' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.7rem', color: '#64748b', fontWeight: 600 }}>Test Patient-ID</label>
            <input
              type="text"
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
              placeholder="e.g. pat-789"
              style={{ width: '100%', padding: '0.3rem', fontSize: '0.75rem', borderRadius: '4px', border: '1px solid #cbd5e1', boxSizing: 'border-box' }}
            />
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.2rem' }}>
          <button
            type="button"
            onClick={runTestQuery}
            disabled={running}
            style={{
              padding: '0.45rem 0.85rem',
              fontSize: '0.8rem',
              fontWeight: 600,
              borderRadius: '6px',
              border: 'none',
              background: running ? '#94a3b8' : '#2563eb',
              color: '#ffffff',
              cursor: running ? 'not-allowed' : 'pointer',
            }}
          >
            {running ? 'Abfrage läuft…' : 'Testabfrage ausführen'}
          </button>
        </div>
      </div>

      {testResult && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.8rem' }}>
          <div>
            <strong>HTTP Status:</strong>{' '}
            <span style={{ color: testResult.error ? '#dc2626' : '#16a34a', fontWeight: 700 }}>
              {testResult.error ? 'Fehler (500)' : `Erfolg (${testResult.status})`}
            </span>
          </div>

          <div>
            <strong>Ausgeführte AQL:</strong>
            <pre style={{ background: '#1e293b', color: '#f8fafc', padding: '0.5rem', borderRadius: '4px', overflowX: 'auto', margin: '0.2rem 0' }}>
              {testResult.query}
            </pre>
          </div>

          <div>
            <strong>Verwendete Parameter:</strong>
            <pre style={{ background: '#ffffff', border: '1px solid #e2e8f0', padding: '0.4rem', borderRadius: '4px', margin: '0.2rem 0' }}>
              {JSON.stringify(testResult.parameters, null, 2)}
            </pre>
          </div>

          {testResult.error ? (
            <div style={{ color: '#dc2626', background: '#fef2f2', padding: '0.5rem', borderRadius: '4px', border: '1px solid #fecaca' }}>
              {testResult.error}
            </div>
          ) : (
            <>
              <div>
                <strong>Zugeordnete Formularfelder:</strong>
                {testResult.mappedFields.length === 0 ? (
                  <p style={{ margin: '0.2rem 0', color: '#64748b' }}>Keine Zuordnungen gefunden.</p>
                ) : (
                  <ul style={{ margin: '0.2rem 0', paddingLeft: '1.2rem' }}>
                    {testResult.mappedFields.map((item) => (
                      <li key={item.mappingId}>
                        <strong>{item.fieldId}</strong> (über <code>{item.resultPath}</code>): {JSON.stringify(item.value)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <strong>Fehlende Zielwerte:</strong>
                {testResult.missingTargets.length === 0 ? (
                  <span style={{ color: '#16a34a', marginLeft: '0.3rem' }}>Keine</span>
                ) : (
                  <ul style={{ margin: '0.2rem 0', paddingLeft: '1.2rem', color: '#d97706' }}>
                    {testResult.missingTargets.map((target, idx) => (
                      <li key={idx}>{target}</li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <strong>Nicht zugeordnete Ergebnisspalten:</strong>
                {testResult.unmappedColumns.length === 0 ? (
                  <span style={{ color: '#64748b', marginLeft: '0.3rem' }}>Keine</span>
                ) : (
                  <span style={{ marginLeft: '0.3rem', fontFamily: 'monospace' }}>
                    {testResult.unmappedColumns.join(', ')}
                  </span>
                )}
              </div>

              <div>
                <strong>Rohresultat:</strong>
                <pre style={{ background: '#ffffff', border: '1px solid #e2e8f0', padding: '0.4rem', borderRadius: '4px', maxHeight: '160px', overflow: 'auto', margin: '0.2rem 0' }}>
                  {JSON.stringify(testResult.rawResult, null, 2)}
                </pre>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
