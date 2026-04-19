import type { Domain, Session } from "@shared/schema";

/**
 * Anomaly detection — `.910`-aligned 2-sigma duration check.
 *
 * Pure function. No I/O, no DB access. Caller supplies the candidate
 * sessions (typically all of a user's non-deleted sessions for the domain).
 *
 * Algorithm:
 *   1. Filter to same-domain sessions whose timestamp falls within
 *      `BASELINE_DAYS` of `now`.
 *   2. If fewer than `COLD_START_THRESHOLD` qualifying samples, return
 *      `coldStart=true` and `isAnomaly=false`. The user has not yet
 *      established a baseline, so we cannot judge anomaly.
 *   3. Compute mean and population standard deviation of those samples.
 *   4. `isAnomaly = |duration - mean| > Z_THRESHOLD * stdDev`. If stdDev
 *      is 0 (all samples identical), only an exact-match duration is
 *      non-anomalous.
 */

export const BASELINE_DAYS = 42;
export const COLD_START_THRESHOLD = 7;
export const Z_THRESHOLD = 2;

export interface AnomalyResult {
  isAnomaly: boolean;
  coldStart: boolean;
  sampleCount: number;
  mean: number;
  stdDev: number;
  zScore: number;
}

export interface DetectAnomalyOptions {
  /** "Now" override for deterministic testing. Default = current time. */
  now?: Date;
}

export interface BaselineResult {
  coldStart: boolean;
  sampleCount: number;
  mean: number;
  stdDev: number;
}

/**
 * Pure baseline summary for a domain — same windowing/cold-start rules as
 * `detectAnomaly`, but without comparing against a candidate duration. Used
 * by surfaces that want to show users what "normal" looks like for them
 * (e.g. Domain Detail) without needing to trigger an anomaly check.
 */
export function computeBaseline<T extends Pick<Session, "domain" | "timestamp" | "durationMinutes">>(
  domain: Domain,
  sessions: T[],
  opts: DetectAnomalyOptions = {},
): BaselineResult {
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - BASELINE_DAYS * 24 * 60 * 60 * 1000;

  const samples: number[] = [];
  for (const s of sessions) {
    if (s.domain !== domain) continue;
    const ts = typeof s.timestamp === "string" ? new Date(s.timestamp) : s.timestamp;
    if (ts.getTime() < cutoff) continue;
    if (ts.getTime() > now.getTime()) continue;
    samples.push(s.durationMinutes);
  }

  if (samples.length < COLD_START_THRESHOLD) {
    return { coldStart: true, sampleCount: samples.length, mean: 0, stdDev: 0 };
  }

  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance =
    samples.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / samples.length;
  const stdDev = Math.sqrt(variance);

  return {
    coldStart: false,
    sampleCount: samples.length,
    mean: Math.round(mean * 100) / 100,
    stdDev: Math.round(stdDev * 100) / 100,
  };
}

export function detectAnomaly<T extends Pick<Session, "domain" | "timestamp" | "durationMinutes">>(
  domain: Domain,
  durationMinutes: number,
  sessions: T[],
  opts: DetectAnomalyOptions = {},
): AnomalyResult {
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - BASELINE_DAYS * 24 * 60 * 60 * 1000;

  const samples: number[] = [];
  for (const s of sessions) {
    if (s.domain !== domain) continue;
    const ts = typeof s.timestamp === "string" ? new Date(s.timestamp) : s.timestamp;
    if (ts.getTime() < cutoff) continue;
    if (ts.getTime() > now.getTime()) continue;
    samples.push(s.durationMinutes);
  }

  if (samples.length < COLD_START_THRESHOLD) {
    return {
      isAnomaly: false,
      coldStart: true,
      sampleCount: samples.length,
      mean: 0,
      stdDev: 0,
      zScore: 0,
    };
  }

  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance =
    samples.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / samples.length;
  const stdDev = Math.sqrt(variance);

  const delta = Math.abs(durationMinutes - mean);
  const zScore = stdDev === 0 ? (delta === 0 ? 0 : Infinity) : delta / stdDev;
  const isAnomaly =
    stdDev === 0 ? delta !== 0 : delta > Z_THRESHOLD * stdDev;

  return {
    isAnomaly,
    coldStart: false,
    sampleCount: samples.length,
    mean: Math.round(mean * 100) / 100,
    stdDev: Math.round(stdDev * 100) / 100,
    zScore: zScore === Infinity ? Infinity : Math.round(zScore * 100) / 100,
  };
}
