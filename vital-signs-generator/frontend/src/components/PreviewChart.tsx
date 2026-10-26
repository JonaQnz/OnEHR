import { CartesianGrid, Legend, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { parseIsoDurationMs } from '../../../shared/isoDuration';
import type { ScenarioEvent, Timepoint } from '../../../shared/types';

interface Props {
  timepoints: Timepoint[];
  events?: ScenarioEvent[];
}

const EVENT_SHADE_COLORS = ['#e05252', '#e2a04a', '#8a4ae2', '#2fa84f', '#4a90e2'];

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Renders whatever the dry-run preview produced - the exact same
 * `Timepoint[]` a real generation run would submit (both call
 * engine/timeline.ts's buildTimepoints), so this chart is a true preview,
 * not an approximation. Shades each event's own time window (snapped to
 * the nearest actual sample points, since the X axis is the categorical
 * list of rendered timepoints, not a continuous time scale) so it's
 * visible where a fever/desaturation/etc. is actually active. */
export function PreviewChart({ timepoints, events = [] }: Props) {
  const rows = timepoints.map((tp) => ({
    time: formatTime(tp.timestamp),
    heartRate: tp.dueTracks.heartRate?.type === 'heartRate' ? tp.dueTracks.heartRate.magnitude : undefined,
    respirationRate: tp.dueTracks.respirationRate?.type === 'respirationRate' ? tp.dueTracks.respirationRate.magnitude : undefined,
    spo2: tp.dueTracks.spo2?.type === 'spo2' ? tp.dueTracks.spo2.percent : undefined,
    bodyTemperature: tp.dueTracks.bodyTemperature?.type === 'bodyTemperature' ? tp.dueTracks.bodyTemperature.magnitude : undefined,
    systolic: tp.dueTracks.bloodPressure?.type === 'bloodPressure' ? tp.dueTracks.bloodPressure.systolic : undefined,
    diastolic: tp.dueTracks.bloodPressure?.type === 'bloodPressure' ? tp.dueTracks.bloodPressure.diastolic : undefined,
  }));

  if (rows.length === 0) {
    return <p style={{ color: '#888' }}>Keine Datenpunkte in dieser Vorschau - Szenario/Tracks prüfen.</p>;
  }

  const eventShades = events
    .map((event, index) => {
      const startMs = Date.parse(event.startTime);
      const endMs = startMs + parseIsoDurationMs(event.durationIso);
      const withinWindow = timepoints
        .map((tp, i) => ({ i, ms: Date.parse(tp.timestamp) }))
        .filter(({ ms }) => ms >= startMs && ms <= endMs);
      if (withinWindow.length === 0) return null;
      return {
        id: event.id,
        label: event.label,
        color: EVENT_SHADE_COLORS[index % EVENT_SHADE_COLORS.length],
        x1: rows[withinWindow[0].i].time,
        x2: rows[withinWindow[withinWindow.length - 1].i].time,
      };
    })
    .filter((shade): shade is NonNullable<typeof shade> => shade !== null);

  return (
    <div style={{ width: '100%', height: 360 }}>
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="time" minTickGap={24} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend />
          {/* No inline ReferenceArea label here on purpose - confirmed live
              that overlapping/adjacent events (as the "Akute
              Verschlechterung" preset's own events are, deliberately)
              stack their text on top of each other into an unreadable
              mess. The event/color legend below the chart identifies each
              shaded band instead, without that failure mode. */}
          {eventShades.map((shade) => (
            <ReferenceArea key={shade.id} x1={shade.x1} x2={shade.x2} fill={shade.color} fillOpacity={0.08} stroke={shade.color} strokeOpacity={0.3} />
          ))}
          <Line type="monotone" dataKey="heartRate" name="Herzfrequenz" stroke="#e05252" dot={false} connectNulls />
          <Line type="monotone" dataKey="respirationRate" name="Atemfrequenz" stroke="#4a90e2" dot={false} connectNulls />
          <Line type="monotone" dataKey="spo2" name="SpO₂ (%)" stroke="#2fa84f" dot={false} connectNulls />
          <Line type="monotone" dataKey="bodyTemperature" name="Temperatur (°C)" stroke="#e2a04a" dot={false} connectNulls />
          <Line type="monotone" dataKey="systolic" name="RR systolisch" stroke="#8a4ae2" dot={false} connectNulls />
          <Line type="monotone" dataKey="diastolic" name="RR diastolisch" stroke="#c14ae2" dot={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
      {eventShades.length > 0 && (
        <ul style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem 1.25rem', listStyle: 'none', padding: 0, margin: '0.4rem 0 0', fontSize: '0.8rem' }}>
          {eventShades.map((shade) => (
            <li key={shade.id} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: shade.color, opacity: 0.5, display: 'inline-block' }} />
              {shade.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
