import type { SignalModel } from '../../../../shared/types';

/** Always returns the same value - the trivial case, but still routed
 * through the registry (index.ts) like every other model kind. */
export function evaluateConstant(model: Extract<SignalModel, { kind: 'constant' }>, _tNormalized: number): number {
  return model.value;
}
