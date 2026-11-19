import type { ThresholdDefinition } from '../config/schema.js';
import type { ThresholdResult } from '../types.js';

export interface ThresholdInput {
  total?: number;
  passed?: number;
  failed?: number;
  successRate?: number;
  durationMs?: number;
  p50?: number;
  p90?: number;
  p95?: number;
  p99?: number;
  rps?: number;
  errorRate?: number;
}

/**
 * Evaluate `min`/`max` thresholds. A threshold whose metric is unavailable for
 * the given input is reported as a failure with actual `NaN`, so a
 * misconfiguration never silently passes.
 */
export function computeThresholds(
  definitions: ThresholdDefinition[] | undefined,
  input: ThresholdInput,
  source: string,
): ThresholdResult[] {
  if (!definitions || definitions.length === 0) return [];
  const results: ThresholdResult[] = [];
  for (const definition of definitions) {
    const actual = input[definition.metric];
    const actualValue = typeof actual === 'number' && Number.isFinite(actual) ? actual : Number.NaN;
    if (definition.min !== undefined) {
      results.push({
        metric: definition.metric,
        operator: 'min',
        limit: definition.min,
        actual: actualValue,
        passed: Number.isFinite(actualValue) && actualValue >= definition.min,
        source,
      });
    }
    if (definition.max !== undefined) {
      results.push({
        metric: definition.metric,
        operator: 'max',
        limit: definition.max,
        actual: actualValue,
        passed: Number.isFinite(actualValue) && actualValue <= definition.max,
        source,
      });
    }
  }
  return results;
}
