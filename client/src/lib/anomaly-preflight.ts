import {
  anomalyCheckResponseSchema,
  type AnomalyCheckRequest,
  type AnomalyCheckResponse,
} from '@shared/schema';

export type AnomalySaveDecision =
  | { kind: 'unavailable' }
  | { kind: 'ordinary' }
  | { kind: 'confirmed-outlier'; note: string };

export type AnomalyPreflightResult =
  | { kind: 'unavailable' }
  | { kind: 'ordinary'; result: AnomalyCheckResponse }
  | { kind: 'outlier'; result: AnomalyCheckResponse };

/** An unavailable preview is not evidence that a session is ordinary. */
export async function checkAnomaly(
  request: AnomalyCheckRequest,
  fetcher: typeof fetch = fetch,
): Promise<AnomalyPreflightResult> {
  try {
    const response = await fetcher('/api/sessions/anomaly-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) return { kind: 'unavailable' };
    const parsed = anomalyCheckResponseSchema.safeParse(await response.json());
    if (!parsed.success) return { kind: 'unavailable' };
    const result = parsed.data;
    const numbers = [result.sampleCount, result.mean, result.stdDev, result.zScore];
    if (!numbers.every(n => Number.isFinite(n) && n >= 0) ||
        !Number.isInteger(result.sampleCount) ||
        (result.coldStart && result.isAnomaly)) return { kind: 'unavailable' };
    return { kind: result.isAnomaly ? 'outlier' : 'ordinary', result };
  } catch {
    // Accepted fail-open behavior, including network/JSON failures.
    return { kind: 'unavailable' };
  }
}

export function anomalyFieldsForSave(
  decision: AnomalySaveDecision,
  editing: false,
): { isAnomaly: boolean; anomalyNote: string | null };
export function anomalyFieldsForSave(
  decision: AnomalySaveDecision,
  editing: true,
): { isAnomaly?: boolean; anomalyNote?: string | null };
export function anomalyFieldsForSave(
  decision: AnomalySaveDecision,
  editing: boolean,
): { isAnomaly?: boolean; anomalyNote?: string | null } {
  // Omit fields on unavailable edits: the server retains its authoritative
  // metadata instead of replacing it with a potentially stale form snapshot.
  if (decision.kind === 'unavailable' && editing) return {};
  if (decision.kind === 'confirmed-outlier') {
    return { isAnomaly: true, anomalyNote: decision.note.trim() };
  }
  return { isAnomaly: false, anomalyNote: null };
}