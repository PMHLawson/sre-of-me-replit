import { z } from "zod";
import { canonical, type EvaluationInput } from "./evaluator-recipe";
import { instant } from "./evaluator-window";
export const CONDITIONS = Object.freeze(["Healthy","NeedsAttention","Warning","Critical"] as const);
export const STATES = Object.freeze(["Nominal","Advisory","Warning","Breach","Critical"] as const);
export type Condition = typeof CONDITIONS[number];
export type Persistence = typeof STATES[number];
export const conditionRanks: Readonly<Record<Condition,number>> = Object.freeze({Healthy:0,NeedsAttention:1,Warning:2,Critical:4});
export const persistenceRanks: Readonly<Record<Persistence,number>> = Object.freeze({Nominal:0,Advisory:1,Warning:2,Breach:3,Critical:4});
export const CALCULATION = "somr426-health-bound-exact-decimal-v1" as const;
export const BOUNDARY = "civil-earliest-repeat-first-valid-gap-v1" as const;
export const ASSEMBLY = "prepared-contiguous-exact-active-coverage-v1" as const;
export function scopeOf(i: EvaluationInput) {
  return {policy:structuredClone(i.policy),recipe:structuredClone(i.recipe),
    onboardingAt:i.coverage.onboardingAt,calculationVersion:CALCULATION,boundaryVersion:BOUNDARY};
}
export type Scope = ReturnType<typeof scopeOf>;
const id=z.string().min(1);
const approval=z.object({sourceId:id,sourceRevision:id,reviewId:id,
  kind:z.enum(["fixture-only","reviewed-external"])}).strict();
const interval=z.object({start:id,end:id}).strict();
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const ProfileShape=z.object({
  profileId:id,version:id,scope:z.unknown(),
  effective:interval,approval,
  assembly:z.object({id:id,version:id,method:z.literal(ASSEMBLY),activeDays:z.literal(7)}).strict(),
  states:z.array(z.object({state:z.enum(STATES),rank:z.number().int().min(0).max(4)}).strict()).length(5),
  selectors:z.object({acceptable:z.array(z.enum(CONDITIONS)).min(1),
    subAcceptable:z.array(z.enum(CONDITIONS)).min(1),severe:z.array(z.enum(CONDITIONS)).min(1)}).strict(),
  promotions:z.array(z.object({ruleId:id,state:z.enum(["Advisory","Warning","Breach","Critical"]),
    selector:z.enum(["subAcceptable","severe"]),blocks:positive,priority:positive}).strict()).min(4),
  recovery:z.object({ruleId:id,selector:z.literal("acceptable"),blocks:positive,state:z.literal("Nominal")}).strict(),
  initial:z.object({kind:z.literal("known-nominal"),at:id,sourceId:id}).strict(),
  tiePolicy:z.literal("retain-both"),
}).strict();
export type PersistenceProfile = Omit<z.infer<typeof ProfileShape>,"scope"> & {scope:Scope};
export type ProfileRegistry = readonly PersistenceProfile[];
/** Explicit version-only comparability: no target, unit or semantic conversions. */
export type Comparability = {
  strategyId:string;version:string;from:Scope;to:Scope;
  effective:{start:string;end:string};
  approval:z.infer<typeof approval>;
  method:"same-semantics-version-transition-v1";
};
export const ComparabilityShape=z.object({strategyId:id,version:id,from:z.unknown(),to:z.unknown(),
  effective:interval,approval,method:z.literal("same-semantics-version-transition-v1")}).strict();
const unique=(a:readonly unknown[])=>new Set(a).size===a.length;
export function validProfile(p: PersistenceProfile): boolean {
  try {
    if(!ProfileShape.safeParse(p).success||!p.scope||instant(p.effective.end)<=instant(p.effective.start))return false;
    if(instant(p.initial.at)<instant(p.effective.start)||instant(p.initial.at)>=instant(p.effective.end))return false;
    if(!unique(p.states.map(s=>s.state))||p.states.some(s=>s.rank!==persistenceRanks[s.state]))return false;
    const s=p.selectors,all=[...s.acceptable,...s.subAcceptable];
    if(!unique(all)||canonical([...all].sort())!==canonical([...CONDITIONS].sort())||
      !unique(s.severe)||s.severe.some(c=>!s.subAcceptable.includes(c)))return false;
    if(!s.acceptable.includes("Healthy")||s.subAcceptable.includes("Healthy")||!s.severe.includes("Critical"))return false;
    const rules=p.promotions;
    if(!unique([...rules.map(r=>r.ruleId),p.recovery.ruleId])||!unique(rules.map(r=>r.priority)))return false;
    if(STATES.slice(1).some(state=>!rules.some(r=>r.state===state)))return false;
    // A lower severity rule may not override a satisfied higher severity rule.
    if(rules.some(a=>rules.some(b=>persistenceRanks[a.state]>persistenceRanks[b.state]&&a.priority<=b.priority)))return false;
    return true;
  } catch {return false;}
}
export function same(a:unknown,b:unknown):boolean {
  // Unlike JSON canonicalization, reject nonfinite values and compare undefined distinctly.
  if((typeof a==="number"&&!Number.isFinite(a))||(typeof b==="number"&&!Number.isFinite(b)))return false;
  if(Object.is(a,b)&&(a===null||typeof a!=="object"))return true;
  if(!a||!b||typeof a!=="object"||typeof b!=="object"||Array.isArray(a)!==Array.isArray(b))return false;
  if(Array.isArray(a)&&Array.isArray(b)&&a.length!==b.length)return false;
  const ak=Object.keys(a),bk=Object.keys(b);
  return ak.length===bk.length&&ak.every(k=>Object.prototype.hasOwnProperty.call(b,k)&&
    same((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k]));
}
export function semanticScope(s:Scope) {
  const copy=structuredClone(s);
  // Only explicitly registered version metadata changes are permitted.
  const {policyVersionId,revision,effectiveFrom,previousVersionId,...policy}=copy.policy;
  const {policyVersionId:rv,version,...recipe}=copy.recipe;
  return {...copy,policy,recipe};
}
