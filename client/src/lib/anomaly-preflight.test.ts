import { describe, expect, it, vi } from 'vitest';
import { checkAnomaly, anomalyFieldsForSave } from './anomaly-preflight';

const ordinary = { isAnomaly: false, coldStart: false, sampleCount: 8, mean: 30, stdDev: 10, zScore: 0 };
const outlier = { ...ordinary, isAnomaly: true, zScore: 2.1 };
const request = { domain: 'music' as const, durationMinutes: 51, excludeSessionId: 'synthetic-edit' };
const fetchReturning = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe('anomaly preflight availability and metadata decisions', () => {
  it.each([ordinary, outlier])('accepts a valid classification %# and forwards edit exclusion', async body => {
    const fetcher = fetchReturning(body);
    expect(await checkAnomaly(request, fetcher)).toEqual({ kind: body.isAnomaly ? 'outlier' : 'ordinary', result: body });
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual(request);
  });
  it('preserves legitimate cold-start ordinary results without deciding a sample threshold', async () => {
    const body = { ...ordinary, coldStart: true, sampleCount: 0, mean: 0, stdDev: 0, zScore: 0 };
    expect(await checkAnomaly(request, fetchReturning(body))).toEqual({ kind: 'ordinary', result: body });
  });
  it.each([400, 401, 500, 503])('treats HTTP%i as unavailable, not ordinary', async status => {
    expect(await checkAnomaly(request, fetchReturning(ordinary, status))).toEqual({ kind: 'unavailable' });
  });
  it('treats network failure as unavailable', async () => {
    expect(await checkAnomaly(request, vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Synthetic network failure'))))
      .toEqual({ kind: 'unavailable' });
  });
  it('treats invalid JSON as unavailable', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"broken":', { status: 200 }));
    expect(await checkAnomaly(request, fetcher)).toEqual({ kind: 'unavailable' });
  });
  it.each([
    null, {}, [], 'ordinary', { isAnomaly: false },
    { ...ordinary, isAnomaly: 'false' }, { ...ordinary, sampleCount: -1 },
    { ...ordinary, sampleCount: 1.5 }, { ...ordinary, mean: null },
    { ...ordinary, stdDev: -1 }, { ...ordinary, zScore: null },
    { ...outlier, coldStart: true },
  ])('rejects unusable responses %# without clearing metadata', async body => {
    expect(await checkAnomaly(request, fetchReturning(body))).toEqual({ kind: 'unavailable' });
  });
  it('does not submit cached anomaly fields for an unavailable edit', () => {
    expect(anomalyFieldsForSave({ kind: 'unavailable' }, true)).toEqual({});
  });
  it('retains existing unavailable-create defaults', () => {
    expect(anomalyFieldsForSave({ kind: 'unavailable' }, false)).toEqual({ isAnomaly: false, anomalyNote: null });
  });
  it('clears obsolete metadata after an ordinary success', () => {
    expect(anomalyFieldsForSave({ kind: 'ordinary' }, true)).toEqual({ isAnomaly: false, anomalyNote: null });
  });
  it('saves confirmed outliers with a trimmed note', () => {
    expect(anomalyFieldsForSave({ kind: 'confirmed-outlier', note: '  intentional practice  ' }, true))
      .toEqual({ isAnomaly: true, anomalyNote: 'intentional practice' });
  });
  it('does not fabricate edit exclusion on create requests', async () => {
    const fetcher = fetchReturning(ordinary);
    await checkAnomaly({ domain: 'music', durationMinutes: 30 }, fetcher);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ domain: 'music', durationMinutes: 30 });
  });
});