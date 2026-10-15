import {computeCompositeState,isInRampUp,computeSustainedOverachievement,completedWindowDays,logicalDay,logicalDayStartUtc} from "./policy-engine";
import {computeEscalationState} from "./escalation";
import type {LegacyHistoryReads} from "./legacy-history";
import type {SessionStateBundle,SessionSummary,DeviationSummary,HistoryPage} from "../../shared/legacy-history";
type Input=Awaited<ReturnType<LegacyHistoryReads["current"]>>;
export function policyResponse(input:Input){
  const {sessions,opts,now}=input,activeDeviations=opts.deviations,userCreatedAt=opts.userCreatedAt;
      const state = computeCompositeState(sessions, opts);
      // C2.3 — Compute trailing sustained-overachievement runs per domain
      // so future notification triggers can read this without recomputing
      // history client-side.
      const sustainedOverachievement = computeSustainedOverachievement(sessions, opts);
      // B3.1 — Surface ramp-up flag on policy-state too so Dashboard surfaces
      // can branch without making a second API call to /api/escalation-state.
      // SOMR-327 — Precompute all chart-range window key sets and a per-session
      // logical-day map so the client can bucket sessions without mirroring the
      // logical-day algorithm. opts already carries timezone/dayStartHour from
      // user_settings, so these are identical to the policy-engine window.
      const w7   = completedWindowDays({ ...opts, windowDays: 7  });
      const w14  = completedWindowDays({ ...opts, windowDays: 14 });
      const w28  = completedWindowDays({ ...opts, windowDays: 28 });
      const w42  = completedWindowDays({ ...opts, windowDays: 42 });
      // prev7: the 7 days that immediately precede the current 7d window.
      // w14 covers 14 completed logical days (oldest→newest); the first half
      // is the 7 days before w7 — no gap, no overlap with w7.
      const prev7 = w14.slice(0, 7);
      // SOMR-327 — Current (in-progress) logical day, excluded from all window
      // sets.  Sent to the client so it can surface live today-context without
      // any client-side timezone arithmetic.
      const todayKey = logicalDay(now, opts);

      // Map every session the user has ever logged to its logical-day key so
      // the client can filter by Set membership with no JS timezone math.
      const sessionDays: Record<string, string> = Object.create(null);
      for (const s of [...sessions, ...input.context]) {
        sessionDays[s.id] = logicalDay(s.timestamp, opts);
      }

      // SOMR-327 (F2, DST) — Compute which w42 logical-day keys each active
      // deviation spans.  Use logicalDayStartUtc for BOTH the start and end of
      // each logical day so that 23-hour spring-forward days and 25-hour
      // fall-back days have exact boundaries — not an assumed 24 h.
      //
      // nextDateKey advances the YYYY-MM-DD key by exactly one UTC calendar
      // date, which is always the next entry in the logical-day sequence.
      const nextDateKey = (dk: string): string => {
        const [yr, mo, dy] = dk.split("-").map(Number);
        return new Date(Date.UTC(yr, mo - 1, dy + 1)).toISOString().slice(0, 10);
      };
      const deviationDayMap: Record<string, string[]> = {};
      for (const d of activeDeviations) {
        const startMs = new Date(d.startAt).getTime();
        const endRaw  = d.endedAt ?? d.endAt ?? null;
        const endMs   = endRaw
          ? new Date(endRaw).getTime()
          : Number.POSITIVE_INFINITY;
        const overlapping = w42.filter((dayKey) => {
          const dayStartMs = logicalDayStartUtc(dayKey, opts).getTime();
          const dayEndMs   = logicalDayStartUtc(nextDateKey(dayKey), opts).getTime();
          return startMs < dayEndMs && endMs > dayStartMs;
        });
        if (overlapping.length > 0) {
          deviationDayMap[d.id] = overlapping;
        }
      }

      return {
        ...state,
        isRampUp: isInRampUp(userCreatedAt, now),
        sustainedOverachievement,
        windowSets: { w7, w14, w28, w42, prev7, deviationDayMap, todayKey },
        sessionDays,
      };
}
export function stateBundle(input:Input,days:number):SessionStateBundle {
  return {ownerUserId:input.ownerUserId,asOf:input.now.toISOString(),complete:true,
    context:{sessions:input.context,deviations:input.contextDeviations,fromInclusive:input.fromInclusive,complete:true},
    policyState:policyResponse(input),escalationState:computeEscalationState(input.sessions,input.opts,days)};
}
