/**
 * SOMR-433 production cadence policy: pure, completed civil-day exposure.
 * A trusted server constructs the episode registry and proves history coverage.
 * Registry membership/source IDs are binding preconditions, NOT authentication
 * or independent proof that a database history is complete.
 * No score, IO, clock, policy writes, rollout or fixture-block persistence.
 */
import { DomainConfigurationSchema, validateObservationContext,
  type DomainConfiguration, type Observation, type QualificationPredicate } from "./domain-config";
import { assembleWindow, instant as millisecondInstant, logicalDay, type Interval } from "./evaluator-window";
import { add, sub, mul, div, compare, decimal, rational, numericEvidence,
  type Fraction } from "./derived-exact";

export const CADENCE_VERSION = "eligible-day-cadence-20261009-v1" as const;
// Complete-history safety bounds: exceeding one is unavailable, never truncation.
export const MAX_CADENCE_HISTORY_DAYS = 3660;
export const MAX_CADENCE_OBSERVATIONS = 2000;
const MAX_CADENCE_EPISODES = 1000;
export type CadenceEpisode = {
  episodeId: string;
  policy: DomainConfiguration;
  windowDays: number;
  targetId: string;
  frequencyMeasurementId: string;
  origin: { at: string; sourceId: string; kind: "verified-effective-policy-origin" };
  effectiveEnd: string | null;
};
export type CadenceInput = {
  episodeId: string;
  now: string;
  history: {
    sourceId: string;
    coveredFrom: string;
    coveredThrough: string;
    observations: Observation[];
    breaks: Interval[];
  };
};
export type ExactCadenceAmount = ReturnType<typeof numericEvidence>;
export type CadenceState = "Nominal" | "RhythmSlipping" | "Advisory" | "Warning" |
  "Breach" | "Critical" | "Recovering";
export type CadenceDay = {
  day: string; start: string; end: string;
  kind: "completed" | "fully-exempt" | "today-pending";
  exposure: ExactCadenceAmount;
  qualifyingObservationIds: string[];
  dayCredit: 0 | 1;
  gap: ExactCadenceAmount;
  lateness: ExactCadenceAmount;
  inspection: { eligible: ExactCadenceAmount; qualifyingDays: number; deficit: ExactCadenceAmount };
  state: CadenceState;
};
type CadenceEvidence = {
  calculationVersion: typeof CADENCE_VERSION;
  episodeId: string; policyVersionId: string | null;
  rawObservations: Observation[]; pendingObservationIds: string[]; futureObservationIds: string[];
  ledger: CadenceDay[];
};
export type CadenceResult = {
  status: "available"; episodeId: string; policyVersionId: string;
  through: string; targetId: string; state: CadenceState;
  label: string; interval: ExactCadenceAmount;
  gap: ExactCadenceAmount; lateness: ExactCadenceAmount;
  inspection: { eligible: ExactCadenceAmount; qualifyingDays: number; deficit: ExactCadenceAmount };
  episodeOpen: boolean; evidence: CadenceEvidence;
} | { status: "unavailable"; reason: string; evidence: CadenceEvidence };

// The shared civil-time assembler operates in exact integer milliseconds.
// Preserve finer source timestamps elsewhere; never silently round them here.
function instant(value:string):number {
  if(typeof value!=="string")throw Error("invalid_instant");
  const fraction=value.match(/T\d\d:\d\d:\d\d\.(\d+)/)?.[1];
  if(fraction && /[1-9]/.test(fraction.slice(3)))throw Error("unsupported_precision");
  return millisecondInstant(value);
}
/**
 * Locate the civil boundary on/after a closed episode's exact end using a
 * constant-size probe. This is boundary arithmetic, not future practice
 * coverage. The real ledger is assembled only through that terminal day and
 * clipped to the effective interval; later evaluation dates add no work.
 */
function terminalCivilBoundary(at:number,boundary:DomainConfiguration["boundary"]):string {
  const probe=new Date(at+3*86400000).toISOString();
  const days=assembleWindow({now:probe,windowDays:5,boundary,breaks:[],
    coverage:{start:new Date(at-7*86400000).toISOString(),end:probe}}).days;
  const terminal=days.find(d=>instant(d.start)<at && at<=instant(d.end));
  if(!terminal)throw Error("civil_boundary_unavailable");
  return terminal.end;
}
const zero = () => rational(BigInt(0), BigInt(1));
const positive = (f: Fraction) => compare(f, zero()) > 0;
const nonnegative = (f: Fraction) => positive(f) ? f : zero();
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 &&
  v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v) && v !== "__proto__";
const keys = (v: unknown, allowed: readonly string[]) => !!v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).every(k => allowed.includes(k)) && allowed.every(k => Object.hasOwn(v, k));
function predicateSupported(p: QualificationPredicate): boolean {
  return p.kind === "condition" ? p.condition.basis.kind === "per_event" :
    p.predicates.length > 0 && p.predicates.every(predicateSupported);
}
function qualifies(p: QualificationPredicate, o: Observation): boolean {
  if (p.kind !== "condition") return p.kind === "all" ?
    p.predicates.every(q => qualifies(q, o)) : p.predicates.some(q => qualifies(q, o));
  const c = p.condition, v = o.values[c.measurementId];
  if (!v) return false;
  if (v.unitId !== c.unitId || v.taskVariantId !== c.taskVariantId || v.valueType !== c.valueType)
    throw Error("qualification_context_unavailable");
  if (c.valueType === "boolean") return v.value === c.constraint.value;
  if (typeof v.value !== "number") throw Error("qualification_context_unavailable");
  const x = decimal(v.value), t = c.constraint;
  return t.operator === "range" ? compare(x, decimal(t.min)) >= 0 && compare(x, decimal(t.max)) <= 0 :
    t.operator === "gte" ? compare(x, decimal(t.value)) >= 0 :
    t.operator === "lte" ? compare(x, decimal(t.value)) <= 0 : compare(x, decimal(t.value)) === 0;
}
function checkedEpisode(e: CadenceEpisode) {
  if (!keys(e, ["episodeId","policy","windowDays","targetId","frequencyMeasurementId","origin","effectiveEnd"]) ||
    !id(e.episodeId) || !id(e.targetId) || !id(e.frequencyMeasurementId) ||
    !DomainConfigurationSchema.safeParse(e.policy).success || !Number.isSafeInteger(e.windowDays) ||
    e.windowDays <= 0 ||
    !keys(e.origin, ["at","sourceId","kind"]) || e.origin.kind !== "verified-effective-policy-origin" ||
    !id(e.origin.sourceId)) throw Error("episode_unverified_or_invalid");
  if(e.windowDays > MAX_CADENCE_HISTORY_DAYS)throw Error("history_resource_limit");
  const origin = instant(e.origin.at), policyStart = instant(e.policy.effectiveFrom);
  if (origin < policyStart || (e.effectiveEnd !== null && instant(e.effectiveEnd) <= origin))
    throw Error("episode_boundary_unavailable");
  const normal = e.policy.targets.normal, adapted = e.policy.targets.adapted;
  const target = e.targetId === normal.targetId ? normal :
    adapted && e.targetId === adapted.target.targetId ? adapted.target : undefined;
  if (!target) throw Error("target_selection_unavailable");
  if (adapted) {
    if (target === normal && (e.effectiveEnd === null || instant(e.effectiveEnd) > instant(adapted.effectiveFrom)))
      throw Error("adaptation_boundary_unavailable");
    if (target === adapted.target && origin < instant(adapted.effectiveFrom))
      throw Error("adaptation_boundary_unavailable");
  }
  const m = e.policy.measurements.find(x => x.measurementId === e.frequencyMeasurementId);
  const ts = target.conditions.filter(x => x.measurementId === e.frequencyMeasurementId);
  if (!m || m.kind !== "frequency" || m.countBy !== "distinct_days" || m.unit.dimension !== "days" ||
    m.role !== "practice" || m.comparisonDirection !== "higher_is_better" || ts.length !== 1)
    throw Error("frequency_unavailable");
  const t = ts[0];
  if (t.valueType !== "integer" || t.constraint.operator !== "gte" || t.constraint.value <= 0 ||
    t.basis.kind !== "period" || t.basis.windowDays !== m.scope.windowDays)
    throw Error("frequency_unavailable");
  if (!e.policy.qualification || !predicateSupported(e.policy.qualification))
    throw Error("qualification_unavailable");
  return { episode: e, interval: div(decimal(t.basis.windowDays), decimal(t.constraint.value)),
    qualification: e.policy.qualification };
}
function stateOf(open: boolean, late: Fraction, gap: Fraction, interval: Fraction,
  deficit: Fraction, windowDays: number): CadenceState {
  if (!open) return "Nominal";
  for (const [numerator, state] of [[4,"Critical"],[3,"Breach"],[2,"Warning"],[1,"Advisory"]] as const)
    if (compare(late, rational(BigInt(windowDays * numerator), BigInt(8))) >= 0) return state;
  if (!positive(late) && positive(deficit)) return "Recovering";
  return positive(late) || compare(gap, interval) > 0 ? "RhythmSlipping" : "Recovering";
}
const reason = (error: unknown) => error instanceof Error && /^[a-z_]+$/.test(error.message) ?
  error.message : "cadence_evidence_unavailable";

/** Server-supplied exact registry; callers cannot promote unregistered episodes. */
export function createCadenceDeriver(trustedEpisodes: readonly CadenceEpisode[]) {
  let registry: ReturnType<typeof checkedEpisode>[] = [], registryError: string | null = null;
  try {
    if (!Array.isArray(trustedEpisodes) || trustedEpisodes.length > MAX_CADENCE_EPISODES)
      throw Error("episode_registry_invalid");
    const copy = structuredClone(trustedEpisodes);
    if (new Set(copy.map(e => e.episodeId)).size !== copy.length) throw Error("episode_registry_conflict");
    registry = copy.map(checkedEpisode);
    // Sort server contexts once instead of quadratic overlap checks.
    const grouped = new Map<string,CadenceEpisode[]>();
    for (const {episode:e} of registry) {
      const key=JSON.stringify([e.policy.organizationId,e.policy.ownerUserId,e.policy.domainId]);
      const group=grouped.get(key)??[];group.push(e);grouped.set(key,group);
    }
    grouped.forEach((group:CadenceEpisode[]) => {
      group.sort((a:CadenceEpisode,b:CadenceEpisode)=>instant(a.origin.at)-instant(b.origin.at));
      for(let i=1;i<group.length;i++)
        if(group[i-1].effectiveEnd===null || instant(group[i-1].effectiveEnd!)>instant(group[i].origin.at))
          throw Error("episode_registry_overlap");
    });
  } catch (error) { registryError = reason(error); }
  function evaluate(input: CadenceInput): CadenceResult {
    const evidence: CadenceEvidence = { calculationVersion: CADENCE_VERSION, episodeId: input?.episodeId ?? "",
      policyVersionId: null, rawObservations: [], pendingObservationIds: [], futureObservationIds: [], ledger: [] };
    const unavailable = (why: string): CadenceResult => ({status:"unavailable",reason:why,evidence});
    try {
      if (registryError) return unavailable(registryError);
      if (!keys(input, ["episodeId","now","history"]) ||
        !keys(input.history, ["sourceId","coveredFrom","coveredThrough","observations","breaks"]))
        return unavailable("history_unverified_or_invalid");
      const selected = registry.find(e => e.episode.episodeId === input.episodeId);
      if (!selected) return unavailable("episode_unregistered");
      const {episode:e, interval, qualification} = selected;
      evidence.policyVersionId = e.policy.policyVersionId;
      // Check envelope cardinality before cloning or assembling any daily history.
      if (!Array.isArray(input.history.observations) || !Array.isArray(input.history.breaks) ||
        input.history.observations.length > MAX_CADENCE_OBSERVATIONS ||
        input.history.breaks.length > MAX_CADENCE_OBSERVATIONS)
        return unavailable("history_resource_limit");
      const h = structuredClone(input.history);
      evidence.rawObservations = h.observations;
      if (h.sourceId !== e.origin.sourceId || h.coveredFrom !== e.origin.at)
        return unavailable("history_coverage_unverified");
      const now = instant(input.now), origin = instant(e.origin.at), originDay = logicalDay(e.origin.at, e.policy.boundary);
      if (now < origin) return unavailable("episode_not_effective");
      for (const b of h.breaks) {
        if (!keys(b, ["start","end"]) || instant(b.end) <= instant(b.start))
          return unavailable("break_interval_unavailable");
      }
      const today = logicalDay(input.now,e.policy.boundary);
      const completed = assembleWindow({now:input.now,windowDays:1,boundary:e.policy.boundary,
        coverage:{start:e.origin.at,end:new Date(Math.max(origin+1,now+1)).toISOString()},breaks:[]});
      const completedEnd = instant(completed.end);
      const through = Math.max(origin, Math.min(completedEnd, e.effectiveEnd === null ? Infinity : instant(e.effectiveEnd)));
      if (instant(h.coveredThrough) !== through) return unavailable("history_incomplete");
      const assemblyNow = through < completedEnd ? terminalCivilBoundary(through,e.policy.boundary) : completed.end;
      const assemblyDay = logicalDay(assemblyNow,e.policy.boundary);
      const elapsed = (Date.parse(assemblyDay+"T12:00:00Z")-Date.parse(originDay+"T12:00:00Z"))/86400000;
      if (!Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed > MAX_CADENCE_HISTORY_DAYS)
        return unavailable("history_resource_limit");
      const seen = new Set<string>(), byDay = new Map<string,string[]>(), pending:string[] = [];
      for (const o of h.observations) {
        if (!validateObservationContext(e.policy,o).success || seen.has(o.observationId))
          return unavailable("observation_context_unavailable");
        seen.add(o.observationId);
        const at = instant(o.observedAt);
        if (at < origin || (e.effectiveEnd !== null && at >= instant(e.effectiveEnd)))
          return unavailable("observation_outside_episode");
        if (at > now) { evidence.futureObservationIds.push(o.observationId); continue; }
        const day = logicalDay(o.observedAt,e.policy.boundary);
        if (at >= completedEnd) evidence.pendingObservationIds.push(o.observationId);
        if (!qualifies(qualification,o)) continue;
        if (day === today) pending.push(o.observationId);
        else {const ids=byDay.get(day)??[];ids.push(o.observationId);byDay.set(day,ids);}
      }
      const days = elapsed ? assembleWindow({now:assemblyNow,windowDays:elapsed,boundary:e.policy.boundary,
        coverage:{start:e.origin.at,end:new Date(Math.max(origin+1,through)).toISOString()},breaks:h.breaks}).days
        .filter(d=>d.coveredMs>0 && instant(d.coveredInterval!.start)<through) : [];
      let gap=zero(), late=zero(), open=false;
      const tail:{exposure:Fraction;credit:0|1}[]=[];
      let totalExposure=zero(), totalCredit=0, tailHead=0;
      const maximum=decimal(e.windowDays);
      const inspect=(exposure:Fraction,credit:0|1) => {
        tail.push({exposure,credit});totalExposure=add(totalExposure,exposure);totalCredit+=credit;
        let excess=sub(totalExposure,maximum);
        while (positive(excess) && tailHead<tail.length) {
          const first=tail[tailHead];
          if(compare(first.exposure,excess)<=0){
            totalExposure=sub(totalExposure,first.exposure);totalCredit-=first.credit;tailHead++;
          }else{
            first.exposure=sub(first.exposure,excess);totalExposure=sub(totalExposure,excess);
          }
          excess=sub(totalExposure,maximum);
        }
        return {eligible:numericEvidence(totalExposure),qualifyingDays:totalCredit,
          deficit:numericEvidence(nonnegative(sub(totalExposure,mul(decimal(totalCredit),interval))))};
      };
      let inspection=inspect(zero(),0);
      const step=(day:string,start:string,end:string,kind:CadenceDay["kind"],exposure:Fraction,ids:string[]) => {
        const credit=ids.length?1:0;
        gap=add(gap,exposure);
        if(open) late=add(late,exposure);
        if(credit) {
          gap=zero();
          if(open) late=nonnegative(sub(late,interval));
        }else if(!open && compare(gap,interval)>0){open=true;late=sub(gap,interval);}
        inspection=inspect(exposure,credit);
        const deficit=nonnegative(sub(totalExposure,mul(decimal(totalCredit),interval)));
        if(credit && open){
          if(compare(late,deficit)>0)late=deficit;
          if(!positive(deficit)&&compare(gap,interval)<=0){late=zero();open=false;}
        }
        const state=stateOf(open,late,gap,interval,deficit,e.windowDays);
        evidence.ledger.push({day,start,end,kind,exposure:numericEvidence(exposure),
          qualifyingObservationIds:[...ids].sort(),dayCredit:credit,gap:numericEvidence(gap),
          lateness:numericEvidence(late),inspection:structuredClone(inspection),state});
      };
      for(const d of days)step(d.day,d.coveredInterval!.start,d.coveredInterval!.end,
        d.coveredMs===d.exemptMs?"fully-exempt":"completed",
        rational(BigInt(d.coveredMs-d.exemptMs),BigInt(d.durationMs)),byDay.get(d.day)??[]);
      // Known actuals receive one immediate day credit. Unfinished Today adds no
      // elapsed exposure, and below-floor Today cannot reset a gap or recover.
      if(pending.length)step(today,new Date(Math.max(origin,completedEnd)).toISOString(),
        new Date(Math.min(now,e.effectiveEnd===null?Infinity:instant(e.effectiveEnd))).toISOString(),
        "today-pending",zero(),pending);
      if(!positive(totalExposure)&&totalCredit===0)return unavailable("no_eligible_coverage");
      const state=evidence.ledger.at(-1)!.state;
      return {status:"available",episodeId:e.episodeId,policyVersionId:e.policy.policyVersionId,
        through:new Date(through).toISOString(),targetId:e.targetId,state,
        label:state==="Critical"?"Sustained Critical":state==="RhythmSlipping"?"Rhythm slipping":state,
        interval:numericEvidence(interval),gap:numericEvidence(gap),lateness:numericEvidence(late),
        inspection,episodeOpen:open,evidence};
    }catch(error){return unavailable(reason(error));}
  }
  return Object.freeze({evaluate});
}
