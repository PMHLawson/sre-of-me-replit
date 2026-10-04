/**
 * GREEN A1.1 pure contract/fixture audit. No direct or transitive evaluator
 * import. Reference arithmetic here checks independently recorded oracles;
 * it is not shipped evaluator, state or policy-selection implementation.
 */
import { describe, expect, it } from "vitest";
import {
  ATTENTION_MAP, PERSISTENCE_ATTENTION_MAP, persistenceStateEnum, conditionBandEnum,
  DEFAULT_BOUNDARY, DEFAULT_CONDITION_BANDS, DEFAULT_GUARDRAIL, SEED_DIMENSIONS,
  TREND_STABILITY_EPSILON, POLICY_V2, UNRESOLVED_POLICY_QUESTIONS,
  boundaryParamsSchema, prorationBasisSchema, rawEvaluationInputSchema,
  sourceBindingSchema, policyVersionSchema, invalidBackdateEvidenceSchema,
  scoredEvaluationSchema, trendEvidenceSchema, normalizeConditionBand, resolveAttention,
  type ScoredEvaluation,
} from "@shared/policy-contract-v2";
import {
  ABSTRACT_CASES, RAW_CASES, COMPOUND, EFFECTIVE_DATING, LADDER_CASES,
  TREND_CASES, ZERO_ELIGIBLE_INPUT, FIXTURE_DOMAIN_POLICY, type RawCase,
} from "./fixtures/policy-v2-cases";

const ids = ["duration", "frequency"] as const;
const close = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 9);
// Fixture-audit-only logical key; all supplied raw examples are summer dates.
// These cases deliberately make no DST validation claim.
function fixtureLogicalKey(timestamp: string, timezone: string, boundary: number) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestamp));
  const read = (key: string) => Number(parts.find(p => p.type === key)!.value);
  return new Date(Date.UTC(read("year"), read("month")-1, read("day") - (read("hour") < boundary ? 1 : 0))).toISOString().slice(0,10);
}
// Declared expected result assembled only to validate output contract shape.
// A1.2 tests never compare an A1.3-enriched object wholesale.
function declaredResult(c: RawCase): ScoredEvaluation {
  const x=c.expected, o=x.outcome;
  return {domain:c.input.domain, windowDays:c.input.windowDays, actual:x.actual, expected:x.targets,
    eligibleWindowBasis:x.eligibleDays, policyVersion:c.input.policy.version,
    calculationVersion:c.input.policy.version.calculationVersion,boundary:c.input.boundary,
    componentEvidence:ids.map(k=>({dimensionId:k,actual:x.actual[k],expected:x.targets[k],
      rawScore:o.raw[k],cappedScore:o.capped[k],weight:SEED_DIMENSIONS[k].weight,
      isMandatory:SEED_DIMENSIONS[k].mandatory,isZero:x.actual[k]===0})),
    domainScore:o.score,conditionBand:o.condition,attentionLevel:ATTENTION_MAP[o.condition],
    guardrailFired:o.guardrailDimensions.length>0,guardrailDimensions:o.guardrailDimensions,
    ...(o.guardrailDimensions.length?{guardrailReason:`Mandatory component: ${o.guardrailDimensions.join(", ")}`} : {}),
    overachievementRaw:o.overachievementRaw,overachievementTier:o.tier,sourceBinding:c.input.provenance,
    consumedObservationIds:x.consumedIds,excludedObservationIds:x.excludedIds,
    today:{observationIds:x.todayIds,durationMinutes:x.todayMinutes},
    proration:{baseDays:c.input.policy.baseDays,windowDays:c.input.windowDays,eligibleDays:x.eligibleDays},
    blockProration:x.blocks};
}

describe("settled seed and input contracts", () => {
  it("both real seed dimensions are mandatory, equally weighted, with logical-block frequency units", () => {
    expect(SEED_DIMENSIONS.duration).toMatchObject({mandatory:true,weight:0.5,unit:"minutes",aggregation:"sum"});
    expect(SEED_DIMENSIONS.frequency).toMatchObject({mandatory:true,weight:0.5,unit:"logical-blocks",aggregation:"distinct-qualified-blocks"});
    expect(SEED_DIMENSIONS.duration.weight + SEED_DIMENSIONS.frequency.weight).toBe(1);
  });
  it("retains default completed-only boundary and 90/70/50 bands", () => {
    expect(boundaryParamsSchema.parse({timezone:"America/New_York",dayStartHour:4}).includeCurrentDay).toBe(false);
    expect(DEFAULT_BOUNDARY.includeCurrentDay).toBe(false);
    expect(DEFAULT_CONDITION_BANDS.map(b=>b.minScore)).toEqual([90,70,50,0]);
    expect(DEFAULT_GUARDRAIL).toEqual({zeroMandatoryForcesCritical:true,mandatoryCapThreshold:0.5,mandatoryCapBand:"WARNING"});
  });
  it.each(conditionBandEnum)("canonical migration input %s is unchanged", band => expect(normalizeConditionBand(band)).toBe(band));
  it("PAGE is input-only", () => {
    expect(normalizeConditionBand("PAGE")).toBe("CRITICAL");
    expect(conditionBandEnum).not.toContain("PAGE");
  });
  it.each([{baseDays:7,windowDays:14,eligibleDays:14},{baseDays:7,windowDays:7,eligibleDays:5.5},ZERO_ELIGIBLE_INPUT])(
    "accepts valid B/W/E including E>B, fractions and zero input: %j", x => expect(prorationBasisSchema.safeParse(x).success).toBe(true));
  it.each([{baseDays:0,windowDays:7,eligibleDays:7},{baseDays:7,windowDays:0,eligibleDays:0},
    {baseDays:7,windowDays:7,eligibleDays:-1},{baseDays:7,windowDays:7,eligibleDays:8}])(
    "rejects invalid B/W/E %j", x=>expect(prorationBasisSchema.safeParse(x).success).toBe(false));
  it("E=0 establishes expected zero only, not any full scoring outcome", () => {
    expect(70*ZERO_ELIGIBLE_INPUT.eligibleDays/ZERO_ELIGIBLE_INPUT.baseDays).toBe(0);
    expect(scoredEvaluationSchema.safeParse({...declaredResult(COMPOUND),eligibleWindowBasis:0}).success).toBe(false);
  });
  it("leaves OA 100<x<101 explicitly unresolved rather than assigning a tier", () => {
    expect(UNRESOLVED_POLICY_QUESTIONS).toEqual(["OA 100<x<101","E=0 scoring"]);
    expect(scoredEvaluationSchema.safeParse({...declaredResult(COMPOUND),overachievementRaw:100.5}).success).toBe(false);
  });
  it("rejects raw-input provenance fabrication and relaxed seed semantics", () => {
    const invented=structuredClone(COMPOUND.input);
    invented.provenance.observationIds.push("not-an-observation");
    expect(rawEvaluationInputSchema.safeParse(invented).success).toBe(false);
    const relaxed=structuredClone(COMPOUND.input);
    relaxed.policy.dimensions[1].mandatory=false;
    expect(rawEvaluationInputSchema.safeParse(relaxed).success).toBe(false);
    const wrongUnit=structuredClone(COMPOUND.input);
    wrongUnit.policy.dimensions[1].unit="minutes";
    expect(rawEvaluationInputSchema.safeParse(wrongUnit).success).toBe(false);
    expect(rawEvaluationInputSchema.safeParse({...COMPOUND.input,provenance:ABSTRACT_CASES[0].provenance}).success).toBe(false);
  });
});

describe.each(ABSTRACT_CASES)("abstract oracle $id", c => {
  it("has truthful abstract provenance and no invented observation identities", () => {
    expect(sourceBindingSchema.parse(c.provenance)).toEqual({kind:"abstract",sourceType:"fixture",fixtureId:c.id});
    expect(c.kind).toBe("abstract");
  });
  it("uses only baseTarget*E/B without intermediate rounding", () => {
    const p=FIXTURE_DOMAIN_POLICY[c.domain];
    for (const k of ids) {
      close(c.expected[k],p[k]*c.E/c.B);
      close(c.outcome.raw[k],100*c.actual[k]/c.expected[k]);
      close(c.outcome.capped[k],Math.min(c.outcome.raw[k],100));
    }
    close(c.outcome.score,ids.reduce((sum,k)=>sum+SEED_DIMENSIONS[k].weight*c.outcome.capped[k],0));
    close(c.outcome.overachievementRaw,Math.min(c.outcome.raw.duration,c.outcome.raw.frequency));
  });
  it("applies guardrails to condition only and uses unrounded score thresholds", () => {
    const band=DEFAULT_CONDITION_BANDS.find(b=>c.outcome.score>=b.minScore)!.band;
    const zero=ids.some(k=>SEED_DIMENSIONS[k].mandatory && c.actual[k]===0);
    const cap=ids.some(k=>SEED_DIMENSIONS[k].mandatory && c.outcome.raw[k]<50);
    const expected=zero?"CRITICAL":cap && ATTENTION_MAP[band]<2?"WARNING":band;
    expect(c.outcome.condition).toBe(expected);
    expect(c.outcome.guardrailDimensions).toEqual(ids.filter(k=>c.outcome.raw[k]<50));
    const raw=c.outcome.overachievementRaw;
    expect(raw>100 && raw<101).toBe(false);
    expect(c.outcome.tier).toBe(raw>=200?"ELITE":raw>=150?"PEAK":raw>=101?"COMMITTED":"NONE");
  });
  it("does not disguise impossible aggregates as raw observations", () => {
    const possible=c.actual.frequency<=c.W && c.actual.duration>=c.actual.frequency*FIXTURE_DOMAIN_POLICY[c.domain].floor;
    expect(c.rawFeasibility==="feasible").toBe(possible);
    if (!possible) expect(RAW_CASES.some(r=>r.id===c.id)).toBe(false);
  });
});

describe("registry and precision regressions", () => {
  it("retains 19 distinct historical math identities but isolates the six impossible originals", () => {
    expect(ABSTRACT_CASES).toHaveLength(19);
    expect(new Set(ABSTRACT_CASES.map(c=>c.id)).size).toBe(19);
    expect(ABSTRACT_CASES.flatMap((c,i)=>c.rawFeasibility==="impossible-aggregates"?[i+1]:[])).toEqual([4,9,12,13,15,16]);
    expect(new Set(RAW_CASES.map(c=>c.id)).size).toBe(RAW_CASES.length);
  });
  it("locks independent corrected fractional golden values", () => {
    close(ABSTRACT_CASES[8].outcome.score,2450/27);
    close(ABSTRACT_CASES[12].outcome.score,500/7);
    expect(ABSTRACT_CASES[12].outcome.condition).toBe("WARNING");
    close(ABSTRACT_CASES[14].outcome.raw.duration,4000/21);
    close(ABSTRACT_CASES[16].outcome.score,1840/21);
    const c=RAW_CASES.find(c=>c.id==="raw-ma-104-not-rounded-healthy")!;
    close(c.expected.outcome.score,1880/21);
    expect(c.expected.outcome.condition).toBe("NEEDS_ATTENTION");
    expect(c.expected.outcome.score).toBeLessThan(90);
  });
  it("uses feasible Music days for PEAK/ELITE, not >7 unprorated weekly MA blocks", () => {
    expect(7/5*100).toBe(140);
    for (const [name,count,total,tier] of [["raw-music-peak",5,75,"PEAK"],["raw-music-elite",6,90,"ELITE"]] as const) {
      const c=RAW_CASES.find(c=>c.id===name)!;
      expect(c.input.observations).toHaveLength(count);
      expect(c.input.observations.every(o=>o.durationMinutes===15)).toBe(true);
      expect(c.expected.actual.duration).toBe(total);
      expect(c.expected.outcome.tier).toBe(tier);
    }
  });
});

describe.each(RAW_CASES)("feasible raw fixture audit $id", c => {
  it("contains raw observations/base targets/versions/deviations and populated provenance only", () => {
    expect(rawEvaluationInputSchema.safeParse(c.input).success).toBe(true);
    expect(c.input).not.toHaveProperty("actual");
    expect(c.input).not.toHaveProperty("expected");
    expect(c.input).not.toHaveProperty("eligibleDays");
    expect(c.input.provenance).toEqual({kind:"observations",sourceType:"fixture",fixtureId:c.id,
      observationIds:c.input.observations.map(o=>o.id),fetchedAt:"2026-08-08T16:00:00Z"});
    expect(new Set(c.input.observations.map(o=>o.id)).size).toBe(c.input.observations.length);
    expect(c.input.policy.version.id).not.toBe(POLICY_V2.id);
    expect(c.input.policy.version.effectiveDate<=c.expected.blocks[0].blockId).toBe(true);
    expect(c.input.policy.dimensions).toEqual([{...SEED_DIMENSIONS.duration},
      {...SEED_DIMENSIONS.frequency,floor:c.input.policy.sessionFloor}]);
  });
  it("independently checks duration and distinct individually qualifying completed blocks", () => {
    const completed=new Set(c.expected.blocks.map(b=>b.blockId));
    const key=(t:string)=>fixtureLogicalKey(t,c.input.boundary.timezone,c.input.boundary.dayStartHour);
    const included=c.input.observations.filter(o=>completed.has(key(o.timestamp)));
    const today=c.input.observations.filter(o=>key(o.timestamp)===key(c.input.evaluatedAt));
    close(included.reduce((sum,o)=>sum+o.durationMinutes,0),c.expected.actual.duration);
    expect(new Set(included.filter(o=>o.durationMinutes>=c.input.policy.sessionFloor).map(o=>key(o.timestamp))).size).toBe(c.expected.actual.frequency);
    expect(included.map(o=>o.id).sort()).toEqual([...c.expected.consumedIds].sort());
    expect(today.map(o=>o.id).sort()).toEqual([...c.expected.todayIds].sort());
    close(today.reduce((sum,o)=>sum+o.durationMinutes,0),c.expected.todayMinutes);
    expect(c.input.observations.filter(o=>!included.includes(o)&&!today.includes(o)).map(o=>o.id).sort()).toEqual([...c.expected.excludedIds].sort());
    for (const b of c.expected.blocks) expect(key(b.startAt)).toBe(b.blockId);
  });
  it("derives fractional eligibility from exact interval/block evidence, not supplied totals", () => {
    const sorted=[...c.input.deviations].sort((a,b)=>Date.parse(a.startAt)-Date.parse(b.startAt));
    for (let i=1;i<sorted.length;i++) expect(Date.parse(sorted[i-1].endAt)).toBeLessThanOrEqual(Date.parse(sorted[i].startAt));
    let E=0;
    for (const b of c.expected.blocks) {
      const start=Date.parse(b.startAt),end=Date.parse(b.endAt);
      const covered=sorted.reduce((sum,d)=>sum+Math.max(0,Math.min(end,Date.parse(d.endAt))-Math.max(start,Date.parse(d.startAt))),0);
      close(covered/(end-start),b.deviatedFraction);
      E+=1-covered/(end-start);
    }
    close(E,c.expected.eligibleDays);
    for (const k of ids) close(c.expected.targets[k],c.input.policy.baseTargets[k]*E/c.input.policy.baseDays);
  });
  it("declares a valid A1.2-only full output with independent component arithmetic", () => {
    expect(scoredEvaluationSchema.safeParse(declaredResult(c)).success).toBe(true);
    for (const k of ids) {
      close(c.expected.outcome.raw[k],100*c.expected.actual[k]/c.expected.targets[k]);
      close(c.expected.outcome.capped[k],Math.min(c.expected.outcome.raw[k],100));
    }
    close(c.expected.outcome.score,(c.expected.outcome.capped.duration+c.expected.outcome.capped.frequency)/2);
  });
});

describe("X1–X7 contract ownership", () => {
  it("X1 labels old/new sub-windows and invalid backdate evidence without selecting a service policy", () => {
    const x=EFFECTIVE_DATING;
    expect(policyVersionSchema.safeParse(x.oldWindow.version).success).toBe(true);
    expect(policyVersionSchema.safeParse(x.newWindow.version).success).toBe(true);
    expect(x.oldWindow.endAt).toBe(x.newWindow.startAt);
    expect(x.oldWindow.version.effectiveDate<=x.oldWindow.startAt.slice(0,10)).toBe(true);
    expect(x.newWindow.version.effectiveDate).toBe(x.newWindow.startAt.slice(0,10));
    expect(Date.parse(x.newVersionRequestedAt)).toBeLessThan(Date.parse(x.newWindow.startAt));
    expect(x.oldWindow.version.id).not.toBe(x.newWindow.version.id);
    expect(x.newWindow.version.calculationVersion).toBeGreaterThan(x.oldWindow.version.calculationVersion);
    expect(invalidBackdateEvidenceSchema.safeParse(x.invalid).success).toBe(true);
  });
  it("X2/X5 compound provenance includes real Today input without scoring it or dropping deviation-time credit", () => {
    expect(COMPOUND.expected.actual).toEqual({duration:84,frequency:4});
    expect(COMPOUND.expected.eligibleDays).toBe(5.5);
    expect(COMPOUND.expected.todayMinutes).toBe(90);
    expect(COMPOUND.input.observations.find(o=>o.id==="compound/today")!.durationMinutes).toBe(90);
    expect(COMPOUND.expected.consumedIds).toContain("compound/aug4");
    expect(COMPOUND.expected.consumedIds).toContain("compound/aug5");
    expect(COMPOUND.expected.consumedIds).not.toContain("compound/today");
    expect(COMPOUND.expected.consumedIds).not.toContain("compound/prior");
  });
  it("X3 uses sustained-state ladders, never storage lifecycle labels", () => {
    expect(persistenceStateEnum).toEqual(["NOMINAL","ADVISORY","WARNING","BREACH","CRITICAL"]);
    expect(Object.values(ATTENTION_MAP)).toEqual([0,1,2,4]);
    expect(Object.values(PERSISTENCE_ATTENTION_MAP)).toEqual([0,1,2,3,4]);
    for(const c of LADDER_CASES) expect(resolveAttention(c.condition,c.persistence)).toBe(c.resolved);
    for(const condition of conditionBandEnum) {
      expect(resolveAttention(condition)).toBe(ATTENTION_MAP[condition]);
      for(const persistence of persistenceStateEnum)
        expect(resolveAttention(condition,persistence)).toBe(Math.max(ATTENTION_MAP[condition],PERSISTENCE_ATTENTION_MAP[persistence]));
    }
  });
  it("X4 makes timezone and boundary changes observable using actual timestamps", () => {
    expect(RAW_CASES.find(c=>c.id==="X4-compound-UTC")!.expected.actual.duration).toBe(114);
    expect(RAW_CASES.find(c=>c.id==="X4-boundary-five-excludes-0405")!.expected.actual).toEqual({duration:100,frequency:4});
  });
  it.each(TREND_CASES)("X6 $id: adjacent equal windows, inclusive ±2pp and truthful driver", c => {
    expect(TREND_STABILITY_EPSILON).toBe(2);
    expect(c.previousWindow.endAt).toBe(c.currentWindow.startAt);
    expect(Date.parse(c.previousWindow.endAt)-Date.parse(c.previousWindow.startAt))
      .toBe(Date.parse(c.currentWindow.endAt)-Date.parse(c.currentWindow.startAt));
    const d=c.current.duration-c.previous.duration,f=c.current.frequency-c.previous.frequency;
    close(c.delta,(d+f)/2);
    const direction=Math.abs(c.delta)<=2?"stable":c.delta>0?"improving":"declining";
    const driver=d*f<0?"offsetting":d===0&&f!==0?"frequency":f===0&&d!==0?"duration":"both";
    expect(c.direction).toBe(direction); expect(c.driver).toBe(driver);
    expect(trendEvidenceSchema.safeParse({direction:c.direction,driver:c.driver,
      deltaPercentagePoints:c.delta,explanation:`Fixture: ${c.driver} movement, ${c.direction}`}).success).toBe(true);
  });
  it("X7 frequency guardrail preserves score 70 but caps condition at WARNING", () => {
    const c=RAW_CASES.find(c=>c.id==="X7-frequency-40-duration-100")!;
    expect(c.expected.outcome.raw).toEqual({duration:100,frequency:40});
    expect(c.expected.outcome.score).toBe(70);
    expect(c.expected.outcome.condition).toBe("WARNING");
    expect(c.expected.outcome.guardrailDimensions).toEqual(["frequency"]);
    expect(SEED_DIMENSIONS.frequency.mandatory).toBe(true);
  });
  it("zero mandatory frequency overrides a score-50 WARNING to CRITICAL without altering score", () => {
    const c=RAW_CASES.find(c=>c.id==="raw-subfloor-zero-mandatory-frequency")!;
    expect(c.expected.actual).toEqual({duration:70,frequency:0});
    expect(c.expected.outcome.score).toBe(50);
    expect(c.expected.outcome.condition).toBe("CRITICAL");
    expect(c.expected.outcome.guardrailDimensions).toEqual(["frequency"]);
    expect(c.input.observations.every(o=>o.durationMinutes<c.input.policy.sessionFloor)).toBe(true);
  });
});