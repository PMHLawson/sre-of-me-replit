/** Pure civil-time assembly. No clock, storage, environment or runtime imports. */
export type Interval = { start: string; end: string };
export type Boundary = { timezone: string; dayStartHour: number };
export type DayCoverage = {
  day: string; start: string; end: string; durationMs: number;
  coveredMs: number; exemptMs: number; eligible: number;
  coveredInterval: Interval | null; exemptIntervals: Interval[];
};
export const instant = (s: string): number => {
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(s) || !Number.isFinite(Date.parse(s)))
    throw Error("invalid_instant");
  // Date.parse normalizes impossible dates such as February 30.
  const date=s.slice(0,10);
  if(new Date(date+"T12:00:00Z").toISOString().slice(0,10)!==date)throw Error("invalid_instant");
  return Date.parse(s);
};
export function shiftDay(day: string, n: number): string {
  const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function formatter(b: Boundary) {
  if (!Number.isInteger(b.dayStartHour) || b.dayStartHour < 0 || b.dayStartHour > 23)
    throw Error("invalid_boundary");
  if(/^[+-]/.test(b.timezone))throw Error("invalid_timezone");
  return new Intl.DateTimeFormat("en-CA", { timeZone: b.timezone, year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}
function parts(at: number, f: Intl.DateTimeFormat) {
  const p = Object.fromEntries(f.formatToParts(at).map(p => [p.type, p.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour,
    wall: Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) };
}
export function logicalDay(at: string, b: Boundary): string {
  return resolvedDay(instant(at), b, formatter(b));
}
/** The containing half-open interval, never a wall-hour comparison.
 * Once an earliest boundary has passed, a fold cannot undo that boundary.
 * Also inspect the next date: a rollback can cross local midnight.
 */
function resolvedDay(at: number, b: Boundary, f: Intl.DateTimeFormat): string {
  let day = parts(at, f).day;
  let start = boundaryAt(day, b, f);
  while (at < start) {
    day = shiftDay(day, -1);
    const previous = boundaryAt(day, b, f);
    if (previous >= start) throw Error("civil_boundary_unavailable");
    start = previous;
  }
  for (;;) {
    const nextDay = shiftDay(day, 1), end = boundaryAt(nextDay, b, f);
    if (end <= start) throw Error("civil_boundary_unavailable");
    if (at < end) return day;
    day = nextDay; start = end;
  }
}
/**
 * DST disambiguation: earliest occurrence for a repeated start; first valid
 * wall time after a skipped start. No fixed-24h assumption.
 */
function boundaryAt(day: string, b: Boundary, f: Intl.DateTimeFormat): number {
  const wall = Date.parse(`${day}T${String(b.dayStartHour).padStart(2, "0")}:00:00Z`);
  const offsets = new Set<number>();
  for (let h = -36; h <= 36; h += 6) {
    const t = wall + h * 3600000; offsets.add(parts(t, f).wall - t);
  }
  const matches = Array.from(offsets).map(o => wall - o).filter(t => parts(t, f).wall === wall);
  if (matches.length) return Math.min(...matches);
  // A nonexistent civil hour: inspect only a transition's bounded neighborhood.
  for (let t = wall - 18 * 3600000; t <= wall + 18 * 3600000; t += 60000) {
    const p = parts(t, f);
    if (p.day === day && p.wall >= wall) return t;
  }
  throw Error("civil_boundary_unavailable");
}
export function assembleWindow(input: {
  now: string; windowDays: number; boundary: Boundary; coverage: Interval; breaks: Interval[];
}): { today: string; start: string; end: string; eligibleDays: number; days: DayCoverage[] } {
  if (!Number.isSafeInteger(input.windowDays) || input.windowDays <= 0) throw Error("invalid_window");
  const f = formatter(input.boundary), now = instant(input.now);
  const today = resolvedDay(now, input.boundary, f);
  const cs = instant(input.coverage.start), ce = instant(input.coverage.end);
  if (ce <= cs) throw Error("invalid_coverage");
  const breaks = input.breaks.map(b => {
    const pair = [instant(b.start), instant(b.end)] as const;
    if (pair[1] <= pair[0]) throw Error("invalid_exception");
    return pair;
  });
  const days: DayCoverage[] = [];
  const iso = (t: number) => new Date(t).toISOString();
  let s = boundaryAt(shiftDay(today, -input.windowDays), input.boundary, f);
  for (let i = -input.windowDays; i < 0; i++) {
    const day = shiftDay(today, i), e = boundaryAt(shiftDay(day, 1), input.boundary, f);
    if (e <= s) throw Error("civil_boundary_unavailable");
    const lo = Math.max(s, cs), hi = Math.min(e, ce);
    const merged: number[][] = [];
    for (const [a, b] of breaks.map(([a,b]) => [Math.max(a, lo), Math.min(b, hi)])
      .filter(([a,b]) => b > a).sort((a,b) => a[0]-b[0])) {
      const last = merged.at(-1);
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a,b]);
    }
    const coveredMs = Math.max(0, hi-lo), exemptMs = merged.reduce((n,[a,b]) => n+b-a,0);
    days.push({ day, start: iso(s), end: iso(e), durationMs: e-s, coveredMs, exemptMs,
      eligible: (coveredMs-exemptMs)/(e-s),
      coveredInterval: hi > lo ? {start:iso(lo),end:iso(hi)} : null,
      exemptIntervals: merged.map(([a,b])=>({start:iso(a),end:iso(b)})) });
    s = e;
  }
  return {today,start:days[0].start,end:days.at(-1)!.end,
    eligibleDays:days.reduce((n,d)=>n+d.eligible,0),days};
}
