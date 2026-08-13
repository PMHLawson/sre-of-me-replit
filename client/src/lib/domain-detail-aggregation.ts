/**
 * Pure aggregation helpers for Domain Detail chart and footer calculations.
 *
 * Extracted from domain-detail.tsx so the aggregation logic can be tested
 * independently without mounting the React component.  All functions are pure
 * (no side-effects, no React hooks) and operate entirely on server-authoritative
 * logical-day keys — no client-side timezone arithmetic.
 */

// ── Label helpers — purely arithmetic, no Date object, no timezone dependency ─

/**
 * Single-letter weekday abbreviations indexed by day-of-week (0 = Sunday).
 * Tuesday and Thursday both map to 'T', matching the existing tick format.
 */
const WEEKDAY_LETTER = ["S", "M", "T", "W", "T", "F", "S"] as const;

/**
 * Three-letter month abbreviations indexed 0–11.
 */
const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * Tomohiko Sakamoto's algorithm — computes the day-of-week for any Gregorian
 * date purely arithmetically (no Date constructor, no timezone involvement).
 * Returns 0 = Sunday … 6 = Saturday.
 */
function weekdayOf(y: number, m: number, d: number): number {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const yr = m < 3 ? y - 1 : y;
  return (
    yr +
    Math.floor(yr / 4) -
    Math.floor(yr / 100) +
    Math.floor(yr / 400) +
    t[m - 1] +
    d
  ) % 7;
}

/**
 * Derive display labels from a YYYY-MM-DD key without constructing a Date.
 *
 * Because no Date object is created, the output is bit-for-bit identical in
 * every JavaScript execution environment regardless of the host's system
 * timezone — UTC+14, UTC−12, or anything in between.  This eliminates the
 * "noon UTC becomes next calendar day in UTC+12…+14" shift that afflicts the
 * `new Date(key + 'T12:00:00Z')` approach.
 */
function labelsFromKey(dayKey: string): { dayLabel: string; fullDate: string } {
  const [y, m, d] = dayKey.split("-").map(Number);
  const wday = weekdayOf(y, m, d);
  return {
    dayLabel: WEEKDAY_LETTER[wday] + d,
    fullDate: MONTH_ABBR[m - 1] + " " + d,
  };
}

// ── Shared types ─────────────────────────────────────────────────────────────

export interface ChartDatum {
  /** YYYY-MM-DD — used as the Recharts categorical-axis key. */
  dateKey: string;
  /** Single letter + day number for completed days (e.g. "T6"); "TODAY" for the live reference. */
  dayLabel: string;
  /** Human-readable label shown in the tooltip, e.g. "Aug 6". */
  fullDate: string;
  minutes: number;
  /**
   * False for every completed logical day returned by `buildChartData`.
   * True only for the single Today reference datum from `buildTodayDatum`.
   * Today is excluded from all window sets and from every SLO / trend calculation.
   */
  isToday: boolean;
  tier: "current" | "previous" | "older";
  hasAnomaly: boolean;
  /** True when the server-authoritative deviationDayMap includes this day. */
  hasDeviation: boolean;
}

/** Minimal session shape required by the aggregation functions. */
export interface DomainSession {
  id: string;
  durationMinutes: number;
  isAnomaly?: boolean | null;
}

// ── Pure functions ────────────────────────────────────────────────────────────

/**
 * Build the full 42-entry chart dataset from server-authoritative day keys.
 *
 * @param w42               Server-computed list of 42 completed logical-day keys
 *                          (oldest → newest).  The returned array has exactly
 *                          `w42.length` entries in the same order.
 * @param sessionDays       Map of sessionId → logical-day key (YYYY-MM-DD).
 *                          Produced by the server so no client-side TZ math is needed.
 * @param domainSessions    Already domain-filtered session list.
 * @param deviationActiveDays
 *                          Pre-computed Set of dayKeys where a deviation for this
 *                          domain was active.  Built by the caller from
 *                          `policyState.windowSets.deviationDayMap` filtered to
 *                          the current domain — keeps domain logic in the component.
 * @param w7Set             Set of dayKeys in the fixed current 7-day window.
 * @param prev7Set          Set of dayKeys in the fixed previous 7-day window.
 */
export function buildChartData(
  w42: string[],
  sessionDays: Record<string, string>,
  domainSessions: DomainSession[],
  deviationActiveDays: Set<string>,
  w7Set: Set<string>,
  prev7Set: Set<string>,
): ChartDatum[] {
  return w42.map((dayKey) => {
    const sameDaySessions = domainSessions.filter(
      (s) => sessionDays[s.id] === dayKey,
    );
    const minutes = sameDaySessions.reduce(
      (sum, s) => sum + s.durationMinutes,
      0,
    );
    const hasAnomaly = sameDaySessions.some((s) => !!s.isAnomaly);
    const hasDeviation = deviationActiveDays.has(dayKey);
    const tier: ChartDatum["tier"] = w7Set.has(dayKey)
      ? "current"
      : prev7Set.has(dayKey)
        ? "previous"
        : "older";
    // Labels are derived by pure integer arithmetic on the YYYY-MM-DD components
    // (Tomohiko Sakamoto weekday + month-name lookup).  No Date object is
    // constructed here, so the output is identical in every JS execution timezone.
    const { dayLabel, fullDate } = labelsFromKey(dayKey);
    return {
      dateKey: dayKey,
      dayLabel,
      fullDate,
      minutes,
      isToday: false,
      tier,
      hasAnomaly,
      hasDeviation,
    };
  });
}

/**
 * Build the single Today reference datum for the Activity History chart.
 *
 * Today is the *current, in-progress* logical day.  It is ALWAYS excluded from
 * the completed-window data produced by `buildChartData` and must never be
 * passed to `sumWindowMinutes`.  This datum is rendered as a visually separated
 * reference column immediately after the completed days so users can answer
 * "did I practice today, and how does it compare to the trend?" without
 * polluting any SLO / scoring window.
 *
 * The caller is responsible for passing the pre-aggregated `todayMinutes` value
 * (i.e. the output of `sumTodayMinutes`).  When no sessions exist today, pass 0
 * — the column renders a clear zero / empty baseline rather than hiding Today.
 *
 * @param todayKey     Server-authoritative YYYY-MM-DD key (`windowSets.todayKey`).
 * @param todayMinutes Pre-aggregated total for today (see `sumTodayMinutes`).
 */
export function buildTodayDatum(todayKey: string, todayMinutes: number): ChartDatum {
  return {
    dateKey: todayKey,
    dayLabel: "TODAY",
    fullDate: "Today",
    minutes: todayMinutes,
    isToday: true,
    tier: "current",   // required by the interface; ignored for Today reference
    hasAnomaly: false,
    hasDeviation: false,
  };
}

/**
 * Sum `durationMinutes` for sessions whose logical-day key falls in `windowKeys`.
 *
 * Below-floor sessions ARE included (SOMR-327: duration totals include all
 * minutes; qualifying-day rules are unchanged and not computed here).
 *
 * @param windowKeys      Array of YYYY-MM-DD keys (e.g. `windowSets.w7`).
 * @param sessionDays     Map of sessionId → logical-day key.
 * @param domainSessions  Already domain-filtered session list.
 */
export function sumWindowMinutes(
  windowKeys: string[],
  sessionDays: Record<string, string>,
  domainSessions: DomainSession[],
): number {
  const keySet = new Set(windowKeys);
  return domainSessions
    .filter((s) => keySet.has(sessionDays[s.id] ?? ""))
    .reduce((sum, s) => sum + s.durationMinutes, 0);
}

/**
 * Sum `durationMinutes` for sessions whose logical-day key equals `todayKey`.
 *
 * Today is the *current, in-progress* logical day — it is intentionally
 * excluded from every window set (w7 … w42) and from all SLO / trend
 * calculations.  This function is the only place where today's minutes are
 * accumulated; callers must never pass today's total into `sumWindowMinutes`.
 *
 * Below-floor minutes are included (same rule as `sumWindowMinutes`).
 *
 * @param todayKey        Server-authoritative YYYY-MM-DD key for the current
 *                        logical day (`windowSets.todayKey`).  Returns 0 when
 *                        absent (windowSets not yet loaded or legacy response).
 * @param sessionDays     Map of sessionId → logical-day key.
 * @param domainSessions  Already domain-filtered session list.
 */
export function sumTodayMinutes(
  todayKey: string | null | undefined,
  sessionDays: Record<string, string>,
  domainSessions: DomainSession[],
): number {
  if (!todayKey) return 0;
  return domainSessions
    .filter((s) => sessionDays[s.id] === todayKey)
    .reduce((sum, s) => sum + s.durationMinutes, 0);
}
