import { useRef, useState } from 'react';

export interface CurvePoint {
  t: number;
  value: number;
}

interface Props {
  points: CurvePoint[];
  onChange: (points: CurvePoint[]) => void;
  valueMin: number;
  valueMax: number;
  unit?: string;
}

const WIDTH = 480;
const HEIGHT = 180;
const PADDING = 24;

function toScreen(point: CurvePoint, valueMin: number, valueMax: number) {
  const x = PADDING + point.t * (WIDTH - 2 * PADDING);
  const range = valueMax - valueMin || 1;
  const y = HEIGHT - PADDING - ((point.value - valueMin) / range) * (HEIGHT - 2 * PADDING);
  return { x, y };
}

function fromScreen(x: number, y: number, valueMin: number, valueMax: number): CurvePoint {
  const t = Math.min(Math.max((x - PADDING) / (WIDTH - 2 * PADDING), 0), 1);
  const range = valueMax - valueMin || 1;
  const value = valueMax - ((y - PADDING) / (HEIGHT - 2 * PADDING)) * range;
  return { t, value };
}

/** Click-to-add / drag-to-move control points for the "drawn curve" signal
 * model - the visual counterpart of engine/signalModels/drawnCurve.ts's
 * piecewise-linear interpolation. Deliberately a small self-contained SVG
 * widget rather than a charting-library dependency, since the interaction
 * (drag a point, click empty space to add one) is the whole feature. */
export function CurveEditor({ points, onChange, valueMin, valueMax, unit }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  const sorted = [...points].sort((a, b) => a.t - b.t);

  function eventToSvgCoords(e: React.PointerEvent): { x: number; y: number } {
    const rect = svgRef.current!.getBoundingClientRect();
    const scaleX = WIDTH / rect.width;
    const scaleY = HEIGHT / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  function handleBackgroundClick(e: React.PointerEvent) {
    if (draggingIndex !== null) return;
    const { x, y } = eventToSvgCoords(e);
    const point = fromScreen(x, y, valueMin, valueMax);
    onChange([...points, point]);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (draggingIndex === null) return;
    const { x, y } = eventToSvgCoords(e);
    const point = fromScreen(x, y, valueMin, valueMax);
    const targetId = sorted[draggingIndex];
    onChange(points.map((p) => (p === targetId ? point : p)));
  }

  const linePath = sorted
    .map((p, i) => {
      const { x, y } = toScreen(p, valueMin, valueMax);
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');

  return (
    <div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        style={{ width: '100%', height: HEIGHT, background: '#fafafa', border: '1px solid #ddd', borderRadius: 6, touchAction: 'none' }}
        onPointerDown={handleBackgroundClick}
        onPointerMove={handlePointerMove}
        onPointerUp={() => setDraggingIndex(null)}
        onPointerLeave={() => setDraggingIndex(null)}
      >
        <line x1={PADDING} y1={HEIGHT - PADDING} x2={WIDTH - PADDING} y2={HEIGHT - PADDING} stroke="#ccc" />
        <line x1={PADDING} y1={PADDING} x2={PADDING} y2={HEIGHT - PADDING} stroke="#ccc" />
        {sorted.length > 1 && <path d={linePath} fill="none" stroke="#4a90e2" strokeWidth={2} />}
        {sorted.map((p, i) => {
          const { x, y } = toScreen(p, valueMin, valueMax);
          return (
            <circle
              key={`${p.t}-${i}`}
              cx={x}
              cy={y}
              r={6}
              fill="#4a90e2"
              stroke="white"
              strokeWidth={1.5}
              style={{ cursor: 'grab' }}
              onPointerDown={(e) => { e.stopPropagation(); setDraggingIndex(i); }}
              onDoubleClick={(e) => { e.stopPropagation(); onChange(points.filter((pt) => pt !== p)); }}
            />
          );
        })}
      </svg>
      <p style={{ fontSize: '0.8rem', color: '#666', margin: '0.35rem 0 0' }}>
        Klicken zum Hinzufügen eines Punkts, ziehen zum Verschieben, Doppelklick zum Entfernen.
        {unit ? ` Werte in ${unit}.` : ''}
      </p>
    </div>
  );
}
