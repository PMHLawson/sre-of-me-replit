const WALL_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/;
const OFFSET = /([+-]\d{2}:\d{2}|Z)$/;

export interface WallTimeCandidate {
  instant: string;
  label: string;
}

function fractionOf(instant: string): string {
  return instant.match(/\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/)?.[1] ?? "";
}

function localParts(instant: string, timezone: string): string | null {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === name)?.value;
    const year = part("year"), month = part("month"), day = part("day");
    const hour = part("hour"), minute = part("minute"), second = part("second");
    if (![year, month, day, hour, minute, second].every(Boolean)) return null;
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  } catch {
    return null;
  }
}

/** Render a saved instant in the account's zone without losing its fractional digits. */
export function formatBreakTime(instant: string | null, timezone: string): string {
  if (instant === null) return "";
  const parts = localParts(instant, timezone);
  if (!parts) return "";
  const fraction = fractionOf(instant);
  const digits = fraction.length > 3 ? fraction : fraction.padEnd(3, "0");
  return `${parts}.${digits}`;
}

/** Native datetime-local controls in Chromium accept millisecond precision, not microseconds. */
export function browserDateTimeValue(value: string): string {
  return value.replace(/\.(\d{3})\d+$/, ".$1");
}

function parseWallTime(value: string) {
  const match = WALL_TIME.exec(value);
  if (!match) return null;
  const [, date, hourText, minuteText, secondText = "00", fractionText = ""] = match;
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const milliseconds = Number((fractionText + "000").slice(0, 3));
  const wallBase = `${date}T${hourText}:${minuteText}:${secondText}`;
  const wallMs = Date.parse(`${wallBase}.${String(milliseconds).padStart(3, "0")}Z`);
  if (!Number.isFinite(wallMs) || new Date(wallMs).toISOString().slice(0, 19) !== wallBase) return null;
  return { wallBase, wallMs, fractionText };
}

function exactIso(milliseconds: number, fractionText: string): string {
  const iso = new Date(milliseconds).toISOString();
  const fraction = (fractionText || "000").padEnd(3, "0");
  const precision = Math.max(3, fractionText.length);
  return `${iso.slice(0, 19)}.${fraction.slice(0, precision)}Z`;
}

/**
 * Convert a wall time using an explicit IANA zone. A repeated hour returns two
 * sorted instants; a skipped hour returns none. The caller must ask the person
 * to choose which repeated occurrence they mean.
 */
export function wallTimeCandidates(value: string, timezone: string): WallTimeCandidate[] {
  const parsed = parseWallTime(value);
  if (!parsed) return [];
  const { wallBase, wallMs, fractionText } = parsed;
  const candidateMs = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sampleMs = Math.floor((wallMs + hours * 60 * 60 * 1000) / 1000) * 1000;
    const sampleIso = new Date(sampleMs).toISOString();
    const local = localParts(sampleIso, timezone);
    if (!local) return [];
    const offsetMs = Date.parse(`${local}.000Z`) - Date.parse(sampleIso);
    const candidate = wallMs - offsetMs;
    const rendered = localParts(new Date(candidate).toISOString(), timezone);
    if (rendered === wallBase) candidateMs.add(candidate);
  }
  const suffix = fractionText || "000";
  return Array.from(candidateMs).sort((a, b) => a - b).map((milliseconds, index) => ({
    instant: exactIso(milliseconds, suffix),
    label: exactIso(milliseconds, suffix),
  })).map((candidate, index) => ({ ...candidate, label: `Occurrence ${index + 1} — ${candidate.label}` }));
}

/** Return the selected unique/explicit occurrence, or null for invalid/ambiguous input. */
export function resolveWallTime(value: string, timezone: string, occurrence = 0): string | null {
  const candidates = wallTimeCandidates(value, timezone);
  if (candidates.length === 1) return candidates[0].instant;
  return candidates.length > 1 ? candidates[occurrence]?.instant ?? null : null;
}

/** Keep an unchanged saved instant verbatim; otherwise honor the chosen fold occurrence. */
export function resolveBreakTime(value: string, timezone: string, occurrence: number | null,
  originalInstant: string | null, changed: boolean): string | null {
  if (originalInstant && !changed) return originalInstant;
  return resolveWallTime(value, timezone, occurrence ?? -1);
}

export function sameInstant(left: string, right: string): boolean {
  const instantTicks = (value: string): bigint | null => {
    if (!OFFSET.test(value)) return null;
    const milliseconds = Date.parse(value);
    const fraction = fractionOf(value);
    if (!Number.isFinite(milliseconds) || fraction.length > 6) return null;
    return BigInt(milliseconds) * BigInt(1000) + BigInt(fraction.padEnd(6, "0").slice(3));
  };
  const a = instantTicks(left), b = instantTicks(right);
  return a !== null && a === b;
}

export function compareBreakInstants(left: string, right: string): number | null {
  const instantTicks = (value: string): bigint | null => {
    if (!OFFSET.test(value)) return null;
    const milliseconds = Date.parse(value);
    const fraction = fractionOf(value);
    if (!Number.isFinite(milliseconds) || fraction.length > 6) return null;
    return BigInt(milliseconds) * BigInt(1000) + BigInt(fraction.padEnd(6, "0").slice(3));
  };
  const a = instantTicks(left), b = instantTicks(right);
  return a === null || b === null ? null : a < b ? -1 : a > b ? 1 : 0;
}

export function occurrenceForInstant(value: string, timezone: string): number {
  const wall = formatBreakTime(value, timezone);
  return wallTimeCandidates(wall, timezone).findIndex(candidate => sameInstant(candidate.instant, value));
}

export function orderedSelection(current: string[], changedId: string, checked: boolean): string[] {
  const next = new Set(current);
  if (checked) next.add(changedId);
  else next.delete(changedId);
  return Array.from(next);
}

export function allSelection(current: string[], activeIds: string[], checked: boolean): string[] {
  if (!checked) return current.filter(id => !activeIds.includes(id));
  return Array.from(new Set([...current, ...activeIds]));
}
