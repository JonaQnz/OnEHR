import { useParams, useSearchParams } from 'react-router-dom';
import CompositionRuntime, { type Mode } from './CompositionRuntime';

// Owns every URL read for the standalone `/compositions/:id` route
// (useParams + useSearchParams) and hands the values to CompositionRuntime
// as props, so the runtime itself never reads the router. The `key={id}`
// remounts the runtime when the route param changes.
function parseMode(value: string | null): Mode | undefined {
  return value === 'edit' || value === 'view' || value === 'prefill' ? value : undefined;
}

export default function CompositionRuntimeRoute() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  return (
    <CompositionRuntime
      key={id}
      formId={id}
      initialPatientId={searchParams.get('patientId') ?? undefined}
      initialNamespace={searchParams.get('patientNamespace') ?? undefined}
      initialEhrId={searchParams.get('ehrId') ?? undefined}
      initialMode={parseMode(searchParams.get('mode'))}
      embedded={searchParams.get('embedded') === '1'}
      returnUrl={searchParams.get('returnUrl') ?? undefined}
      forceNew={searchParams.get('forceNew') === 'true'}
    />
  );
}
