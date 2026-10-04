/**
 * Two intentionally separate registries:
 * ABSTRACT_CASES preserves the 19 historical identities as pure algebra, with
 * corrected unrounded expectations and truthful non-observation provenance.
 * RAW_CASES contains only feasible invented observations for A1.2.
 * Neither registry invokes or implements an evaluator/state/trend pipeline.
 */
import {
  DEFAULT_BOUNDARY, SEED_DIMENSIONS, type ConditionBand, type DimensionValues,
  type OverachievementTierV2, type PolicyVersion, type RawEvaluationInput,
  type SourceBinding, type InvalidBackdateEvidence,
} from "@shared/policy-contract-v2";

export const FIXTURE_DOMAIN_POLICY = {
  "martial-arts": { duration: 105, frequency: 5, floor: 15 },
  meditation: { duration: 70, frequency: 5, floor: 10 },
  fitness: { duration: 90, frequency: 5, floor: 15 },
  music: { duration: 45, frequency: 3, floor: 15 },
} as const;
export type FixtureDomain = keyof typeof FIXTURE_DOMAIN_POLICY;
export interface GoldenOutcome {
  raw: DimensionValues; capped: DimensionValues; score: number;
  condition: ConditionBand; overachievementRaw: number; tier: OverachievementTierV2;
  guardrailDimensions: ("duration" | "frequency")[];
}
export interface AbstractCase {
  id: string; kind: "abstract"; domain: FixtureDomain;
  W: number; B: number; E: number; actual: DimensionValues;
  expected: DimensionValues; outcome: GoldenOutcome; provenance: SourceBinding;
  rawFeasibility: "feasible" | "impossible-aggregates";
}
// Receives independent literal/fraction oracles, not computed evaluator output.
function algebra(id: string, domain: FixtureDomain, W: number, E: number, D: number, F: number,
  expected: DimensionValues, raw: DimensionValues, score: number, condition: ConditionBand,
  tier: OverachievementTierV2, rawFeasibility: AbstractCase["rawFeasibility"] = "feasible"): AbstractCase {
  return { id, kind: "abstract", domain, W, B: 7, E, actual: { duration: D, frequency: F }, expected,
    outcome: { raw, capped: { duration: Math.min(raw.duration, 100), frequency: Math.min(raw.frequency, 100) },
      score, condition, tier, overachievementRaw: Math.min(raw.duration, raw.frequency),
      guardrailDimensions: (["duration", "frequency"] as const).filter(k => raw[k] < 50) },
    provenance: { kind: "abstract", sourceType: "fixture", fixtureId: id }, rawFeasibility };
}
const v = (duration: number, frequency: number): DimensionValues => ({ duration, frequency });
export const ABSTRACT_CASES: AbstractCase[] = [
  algebra("w7-martial-arts-healthy", "martial-arts", 7, 7, 120, 5, v(105,5), v(800/7,100), 100, "HEALTHY", "NONE"),
  algebra("w7-meditation-needs-attention", "meditation", 7, 7, 56, 4, v(70,5), v(80,80), 80, "NEEDS_ATTENTION", "NONE"),
  algebra("w7-fitness-warning", "fitness", 7, 7, 45, 3, v(90,5), v(50,60), 55, "WARNING", "NONE"),
  algebra("w7-music-critical", "music", 7, 7, 10, 1, v(45,3), v(200/9,100/3), 250/9, "CRITICAL", "NONE", "impossible-aggregates"),
  algebra("w14-martial-arts-scaled", "martial-arts", 14, 14, 230, 10, v(210,10), v(2300/21,100), 100, "HEALTHY", "NONE"),
  algebra("w28-meditation-scaled", "meditation", 28, 28, 252, 18, v(280,20), v(90,90), 90, "HEALTHY", "NONE"),
  algebra("w42-fitness-scaled", "fitness", 42, 42, 432, 24, v(540,30), v(80,80), 80, "NEEDS_ATTENTION", "NONE"),
  algebra("w10-martial-arts-arbitrary", "martial-arts", 10, 10, 160, 8, v(150,50/7), v(320/3,112), 100, "HEALTHY", "COMMITTED"),
  algebra("w30-music-arbitrary", "music", 30, 30, 170, 12, v(1350/7,90/7), v(2380/27,280/3), 2450/27, "HEALTHY", "NONE", "impossible-aggregates"),
  algebra("stitch-14d-martial-arts", "martial-arts", 14, 14, 135, 5, v(210,10), v(450/7,50), 400/7, "WARNING", "NONE"),
  algebra("proration-14d-4deviated-meditation", "meditation", 14, 10, 90, 7, v(100,50/7), v(90,98), 94, "HEALTHY", "NONE"),
  algebra("guardrail-zero-duration-critical", "meditation", 7, 7, 0, 5, v(70,5), v(0,100), 50, "CRITICAL", "NONE", "impossible-aggregates"),
  algebra("guardrail-cap-mandatory-warning", "meditation", 7, 7, 30, 5, v(70,5), v(300/7,100), 500/7, "WARNING", "NONE", "impossible-aggregates"),
  algebra("overachievement-committed-martial-arts", "martial-arts", 7, 7, 130, 7, v(105,5), v(2600/21,140), 100, "HEALTHY", "COMMITTED"),
  algebra("overachievement-peak-martial-arts", "martial-arts", 7, 7, 200, 10, v(105,5), v(4000/21,200), 100, "HEALTHY", "PEAK", "impossible-aggregates"),
  algebra("overachievement-elite-martial-arts", "martial-arts", 7, 7, 240, 12, v(105,5), v(1600/7,240), 100, "HEALTHY", "ELITE", "impossible-aggregates"),
  algebra("boundary-hour-before-start-excluded", "martial-arts", 7, 7, 100, 4, v(105,5), v(2000/21,80), 1840/21, "NEEDS_ATTENTION", "NONE"),
  algebra("boundary-hour-after-start-included", "martial-arts", 7, 7, 125, 5, v(105,5), v(2500/21,100), 100, "HEALTHY", "NONE"),
  algebra("migration-page-to-critical", "meditation", 7, 7, 15, 1, v(70,5), v(150/7,20), 145/7, "CRITICAL", "NONE"),
];

export const SYNTHETIC_VERSION: PolicyVersion = {
  id: "fixture-only/settled-v2-old", effectiveDate: "2026-01-01", calculationVersion: 1,
};
const dayMs = 86400000;
const completedEnd = Date.parse("2026-08-08T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
export interface RawCase {
  id: string; input: RawEvaluationInput;
  expected: {
    actual: DimensionValues; targets: DimensionValues; eligibleDays: number;
    outcome: GoldenOutcome; consumedIds: string[]; excludedIds: string[];
    todayIds: string[]; todayMinutes: number;
    blocks: { blockId: string; startAt: string; endAt: string; deviatedFraction: number }[];
  };
}
function inputFor(id: string, domain: FixtureDomain, W: number): RawEvaluationInput {
  const p = FIXTURE_DOMAIN_POLICY[domain];
  return { domain, evaluatedAt: "2026-08-08T16:00:00Z", windowDays: W,
    boundary: { ...DEFAULT_BOUNDARY },
    policy: { version: { ...SYNTHETIC_VERSION }, baseDays: 7,
      baseTargets: v(p.duration, p.frequency), sessionFloor: p.floor,
      dimensions: [{ ...SEED_DIMENSIONS.duration }, { ...SEED_DIMENSIONS.frequency, floor: p.floor }] },
    observations: [], deviations: [],
    provenance: { kind: "observations", sourceType: "fixture", fixtureId: id, observationIds: [], fetchedAt: "2026-08-08T16:00:00Z" } };
}
function blocksFor(W: number, offsetHours = 0): RawCase["expected"]["blocks"] {
  return Array.from({ length: W }, (_, i) => {
    const start = completedEnd - W * dayMs + i * dayMs + offsetHours * 3600000;
    return { blockId: iso(start).slice(0,10), startAt: iso(start), endAt: iso(start + dayMs), deviatedFraction: 0 };
  });
}
function bind(input: RawEvaluationInput) {
  if (input.provenance.kind !== "observations") throw new Error("Raw fixture provenance required");
  input.provenance.observationIds = input.observations.map(o => o.id);
}
// Materialize invented observations on distinct days; rejects impossible algebra.
function rawFromAbstract(a: AbstractCase): RawCase {
  if (a.rawFeasibility !== "feasible") throw new Error("Abstract-only case cannot enter raw registry");
  const input = inputFor(a.id, a.domain, a.W), blocks = blocksFor(a.W);
  input.observations = Array.from({ length: a.actual.frequency }, (_, i) => ({
    id: `${a.id}/observation-${i+1}`,
    timestamp: iso(Date.parse(blocks[i].startAt) + 5*3600000),
    durationMinutes: a.actual.duration / a.actual.frequency,
  }));
  if (a.E < a.W) {
    const days = a.W - a.E;
    input.deviations = [{ id: `${a.id}/deviation`, startAt: blocks[0].startAt, endAt: blocks[days-1].endAt }];
    for (let i = 0; i < days; i++) blocks[i].deviatedFraction = 1;
  }
  bind(input);
  return { id: a.id, input, expected: { actual: { ...a.actual }, targets: { ...a.expected }, eligibleDays: a.E,
    outcome: a.outcome, consumedIds: input.observations.map(o=>o.id), excludedIds: [], todayIds: [], todayMinutes: 0, blocks } };
}
const feasibleOriginals = ABSTRACT_CASES.filter(a => a.rawFeasibility === "feasible").map(rawFromAbstract);
const stitched = feasibleOriginals.find(c => c.id === "stitch-14d-martial-arts")!;
stitched.input.observations = [
  ...Array.from({length:3}, (_,i)=>({id:`stitch/week1-${i}`,timestamp:`2026-07-${25+i}T13:00:00Z`,durationMinutes:80/3})),
  ...Array.from({length:2}, (_,i)=>({id:`stitch/week2-${i}`,timestamp:`2026-08-0${1+i}T13:00:00Z`,durationMinutes:55/2})),
];
stitched.expected.consumedIds = stitched.input.observations.map(o=>o.id);
bind(stitched.input);
// Make the original boundary identities real timestamp tests, not just labels.
for (const id of ["boundary-hour-before-start-excluded", "boundary-hour-after-start-included"]) {
  const r = feasibleOriginals.find(c=>c.id===id)!;
  const after = id.includes("after");
  r.input.observations = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: `${id}/regular-${i}`, timestamp: `2026-08-0${i+2}T13:00:00Z`, durationMinutes: 25 })),
    { id: `${id}/boundary`, timestamp: after ? "2026-08-01T08:05:00Z" : "2026-08-01T07:55:00Z", durationMinutes: 25 },
  ];
  r.expected.consumedIds = r.input.observations.filter(o=>after || !o.id.endsWith("/boundary")).map(o=>o.id);
  r.expected.excludedIds = after ? [] : [`${id}/boundary`];
  bind(r.input);
}
function extraMath(id: string, domain: FixtureDomain, D: number, F: number, raw: DimensionValues,
  score: number, condition: ConditionBand, tier: OverachievementTierV2): RawCase {
  const p = FIXTURE_DOMAIN_POLICY[domain];
  return rawFromAbstract(algebra(id, domain, 7, 7, D, F, v(p.duration,p.frequency), raw, score, condition, tier));
}
const musicPeak = extraMath("raw-music-peak", "music", 75,5, v(500/3,500/3),100,"HEALTHY","PEAK");
const musicElite = extraMath("raw-music-elite", "music",90,6,v(200,200),100,"HEALTHY","ELITE");
const precise = extraMath("raw-ma-104-not-rounded-healthy","martial-arts",104,4,v(2080/21,80),1880/21,"NEEDS_ATTENTION","NONE");
const frequencyGuardrail = extraMath("X7-frequency-40-duration-100","martial-arts",105,2,v(100,40),70,"WARNING","NONE");

const compoundInput = inputFor("raw-compound-meditation", "meditation",7);
compoundInput.observations = [
  {id:"compound/aug1-am",timestamp:"2026-08-01T13:00:00Z",durationMinutes:12},
  {id:"compound/aug1-pm",timestamp:"2026-08-01T18:00:00Z",durationMinutes:15},
  {id:"compound/aug2",timestamp:"2026-08-02T13:00:00Z",durationMinutes:10},
  {id:"compound/aug3-am",timestamp:"2026-08-03T13:00:00Z",durationMinutes:8},
  {id:"compound/aug3-pm",timestamp:"2026-08-03T18:00:00Z",durationMinutes:7},
  {id:"compound/aug4",timestamp:"2026-08-04T13:00:00Z",durationMinutes:20},
  {id:"compound/aug5",timestamp:"2026-08-05T13:00:00Z",durationMinutes:12},
  {id:"compound/today",timestamp:"2026-08-08T13:00:00Z",durationMinutes:90},
  {id:"compound/prior",timestamp:"2026-08-01T07:55:00Z",durationMinutes:30},
];
compoundInput.deviations = [
  {id:"compound/full",startAt:"2026-08-04T08:00:00Z",endAt:"2026-08-05T08:00:00Z"},
  {id:"compound/half",startAt:"2026-08-05T08:00:00Z",endAt:"2026-08-05T20:00:00Z"},
];
bind(compoundInput);
const compoundBlocks = blocksFor(7);
compoundBlocks[3].deviatedFraction=1; compoundBlocks[4].deviatedFraction=0.5;
export const COMPOUND: RawCase = {
  id:"raw-compound-meditation", input:compoundInput,
  expected:{actual:v(84,4), targets:v(55,55/14),eligibleDays:5.5,
    outcome:{raw:v(1680/11,1120/11),capped:v(100,100),score:100,condition:"HEALTHY",overachievementRaw:1120/11,tier:"COMMITTED",guardrailDimensions:[]},
    consumedIds:compoundInput.observations.slice(0,7).map(o=>o.id), excludedIds:["compound/prior"],
    todayIds:["compound/today"],todayMinutes:90,blocks:compoundBlocks},
};
// Same instants, different effective timezone: the 07:55Z observation now belongs
// to completed Aug1. Deviation credit totals remain 1.5 days (5/6 + 2/3).
const utcCompound: RawCase = structuredClone(COMPOUND);
utcCompound.id="X4-compound-UTC";
utcCompound.input.boundary.timezone="UTC";
utcCompound.input.provenance={...compoundInput.provenance, fixtureId:utcCompound.id};
utcCompound.expected.actual=v(114,4);
utcCompound.expected.outcome={...COMPOUND.expected.outcome,raw:v(2280/11,1120/11)};
utcCompound.expected.consumedIds.push("compound/prior");
utcCompound.expected.excludedIds=[];
utcCompound.expected.blocks=blocksFor(7,-4);
utcCompound.expected.blocks[3].deviatedFraction=5/6;
utcCompound.expected.blocks[4].deviatedFraction=2/3;
const shiftedBoundary: RawCase = structuredClone(feasibleOriginals.find(c=>c.id==="boundary-hour-after-start-included")!);
shiftedBoundary.id="X4-boundary-five-excludes-0405";
shiftedBoundary.input.boundary.dayStartHour=5;
shiftedBoundary.input.provenance={...shiftedBoundary.input.provenance,fixtureId:shiftedBoundary.id};
shiftedBoundary.expected=structuredClone(feasibleOriginals.find(c=>c.id==="boundary-hour-before-start-excluded")!.expected);
shiftedBoundary.expected.blocks=blocksFor(7,1);
shiftedBoundary.expected.consumedIds=shiftedBoundary.input.observations.slice(0,4).map(o=>o.id);
shiftedBoundary.expected.excludedIds=[shiftedBoundary.input.observations[4].id];

const zeroFrequencyInput=inputFor("raw-subfloor-zero-mandatory-frequency","meditation",7);
zeroFrequencyInput.observations=Array.from({length:14},(_,i)=>({
  id:`zero-f/subfloor-${i}`,timestamp:`2026-08-01T13:${String(i).padStart(2,"0")}:00Z`,durationMinutes:5,
}));
bind(zeroFrequencyInput);
const zeroFrequency:RawCase={id:"raw-subfloor-zero-mandatory-frequency",input:zeroFrequencyInput,
  expected:{actual:v(70,0),targets:v(70,5),eligibleDays:7,
    outcome:{raw:v(100,0),capped:v(100,0),score:50,condition:"CRITICAL",overachievementRaw:0,tier:"NONE",guardrailDimensions:["frequency"]},
    consumedIds:zeroFrequencyInput.observations.map(o=>o.id),excludedIds:[],todayIds:[],todayMinutes:0,blocks:blocksFor(7)}};
const emptyInput=inputFor("raw-empty-both-mandatory-zero","meditation",7);
const empty:RawCase={id:"raw-empty-both-mandatory-zero",input:emptyInput,
  expected:{actual:v(0,0),targets:v(70,5),eligibleDays:7,
    outcome:{raw:v(0,0),capped:v(0,0),score:0,condition:"CRITICAL",overachievementRaw:0,tier:"NONE",guardrailDimensions:["duration","frequency"]},
    consumedIds:[],excludedIds:[],todayIds:[],todayMinutes:0,blocks:blocksFor(7)}};
export const RAW_CASES:RawCase[]=[
  ...feasibleOriginals,musicPeak,musicElite,precise,frequencyGuardrail,COMPOUND,utcCompound,shiftedBoundary,zeroFrequency,empty,
];

// X1 is pure contract evidence, NOT a demand that A1.2 select/stitch policies.
export const EFFECTIVE_DATING = {
  oldWindow: {startAt:"2026-08-01T08:00:00Z",endAt:"2026-08-04T08:00:00Z",version:SYNTHETIC_VERSION},
  newWindow: {startAt:"2026-08-04T08:00:00Z",endAt:"2026-08-08T08:00:00Z",
    version:{id:"fixture-only/settled-v2-new",effectiveDate:"2026-08-04",calculationVersion:2} satisfies PolicyVersion},
  newVersionRequestedAt:"2026-08-03T16:00:00Z",
  invalid: {kind:"invalid-backdate",reason:"EFFECTIVE_DATE_BEFORE_REQUEST",
    requestedAt:"2026-08-10T16:00:00Z",proposedEffectiveDate:"2026-08-01",existingVersion:SYNTHETIC_VERSION} satisfies InvalidBackdateEvidence,
};
export const ZERO_ELIGIBLE_INPUT = {baseDays:7,windowDays:7,eligibleDays:0};
export const LADDER_CASES = [
  {condition:"HEALTHY",persistence:"BREACH",resolved:3},
  {condition:"WARNING",persistence:"ADVISORY",resolved:2},
  {condition:"CRITICAL",persistence:"NOMINAL",resolved:4},
  {condition:"NEEDS_ATTENTION",persistence:undefined,resolved:1},
] as const;
// X6: adjacent equal 7-block windows, frozen synthetic comparison expectations.
// No trend classification implementation; no A1.2 integration dependency.
export const TREND_CASES = [
  {id:"stable-no-change",previous:v(80,80),current:v(80,80),delta:0,direction:"stable",driver:"both"},
  {id:"plus-two-inclusive",previous:v(80,80),current:v(82,82),delta:2,direction:"stable",driver:"both"},
  {id:"minus-two-inclusive",previous:v(80,80),current:v(78,78),delta:-2,direction:"stable",driver:"both"},
  {id:"declining-both",previous:v(80,80),current:v(77,77),delta:-3,direction:"declining",driver:"both"},
  {id:"improving-both",previous:v(80,80),current:v(83,83),delta:3,direction:"improving",driver:"both"},
  {id:"frequency-decline",previous:v(80,80),current:v(80,70),delta:-5,direction:"declining",driver:"frequency"},
  {id:"duration-improvement",previous:v(80,80),current:v(90,80),delta:5,direction:"improving",driver:"duration"},
  {id:"offsetting-stable",previous:v(80,80),current:v(90,70),delta:0,direction:"stable",driver:"offsetting"},
  {id:"offsetting-decline",previous:v(80,80),current:v(84,70),delta:-3,direction:"declining",driver:"offsetting"},
].map(c=>({...c,previousWindow:{startAt:"2026-07-25T08:00:00Z",endAt:"2026-08-01T08:00:00Z"},
  currentWindow:{startAt:"2026-08-01T08:00:00Z",endAt:"2026-08-08T08:00:00Z"},
  boundary:{...DEFAULT_BOUNDARY},policyVersion:SYNTHETIC_VERSION}));