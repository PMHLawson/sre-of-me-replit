/** Exact provenance arithmetic. Never use exported evaluator scores as inputs. */
import type { EvaluationResult } from "./pure-evaluator";
export type Fraction = { n: bigint; d: bigint };
const ZERO=BigInt(0),ONE=BigInt(1);
export function rational(n: bigint, d: bigint): Fraction {
  if (!d) throw Error("zero_denominator");
  if (d < ZERO) { n = -n; d = -d; }
  let a = n < ZERO ? -n : n, b = d;
  while (b) { const t = a % b; a = b; b = t; }
  return { n: n / a, d: d / a };
}
export function decimal(v: number): Fraction {
  if (!Number.isFinite(v)) throw Error("nonfinite_decimal");
  const [m, e = "0"] = String(v).split("e"), [w, t = ""] = m.split(".");
  const scale = t.length - Number(e), power = BigInt("1"+"0".repeat(Math.abs(scale)));
  return scale >= 0 ? rational(BigInt(w + t), power) : rational(BigInt(w + t) * power, ONE);
}
export const add = (a: Fraction, b: Fraction) => rational(a.n*b.d+b.n*a.d,a.d*b.d);
export const neg = (a: Fraction) => rational(-a.n,a.d);
export const sub = (a: Fraction, b: Fraction) => add(a,neg(b));
export const mul = (a: Fraction, b: Fraction) => rational(a.n*b.n,a.d*b.d);
export const div = (a: Fraction, b: Fraction) => rational(a.n*b.d,a.d*b.n);
export const compare = (a: Fraction, b: Fraction) => {
  const d=a.n*b.d-b.n*a.d; return d<ZERO?-1:d>ZERO?1:0;
};
export const exact = (f: Fraction) => ({numerator:String(f.n),denominator:String(f.d)});
/** Approximate presentation only; exact numerator/denominator always accompanies it. */
export function approximate(f: Fraction): number {
  const n=Number(f.n),d=Number(f.d);
  if(Number.isFinite(n)&&Number.isFinite(d))return n/d;
  const sign=f.n<ZERO?-1:1,ns=String(f.n<ZERO?-f.n:f.n),ds=String(f.d);
  const exponent=ns.length-ds.length;
  // Fold exponent into the decimal string to avoid intermediate overflow/underflow.
  return sign*Number(`${Number(ns.slice(0,16))/Number(ds.slice(0,16))}e${exponent-Math.min(16,ns.length)+Math.min(16,ds.length)}`);
}
export const numericEvidence = (f: Fraction) => ({...exact(f),approximate:approximate(f)});
export function eligible(result: EvaluationResult): Fraction {
  const w=result.evidence.window;
  if(!w)throw Error("missing_window");
  return w.days.reduce((sum,d)=>{
    if(![d.coveredMs,d.exemptMs,d.durationMs].every(Number.isSafeInteger)||d.durationMs<=0)
      throw Error("invalid_integer_coverage");
    return add(sum,rational(BigInt(d.coveredMs-d.exemptMs),BigInt(d.durationMs)));
  },decimal(0));
}
/** Call only after exact evaluator replay validation. IDs and days are replay-verified. */
export function reconstruct(result: EvaluationResult) {
  if(result.status!=="available")throw Error("health_unavailable");
  const e=eligible(result),r=result.evidence.provenance.recipe;
  const totalWeight=r.components.reduce((s,c)=>add(s,decimal(c.weight)),decimal(0));
  const components=result.evidence.components.map((c,j)=>{
    const recipe=r.components[j],ids=new Set(c.observationIds);
    const actual=recipe.actual==="distinct-qualifying-days"?decimal(c.qualifyingDays.length):
      result.evidence.completed.filter(o=>ids.has(o.observationId)).reduce((sum,o)=>{
        const value=o.values[c.measurementId].value;
        if(typeof value!=="number")throw Error("invalid_numeric_value");
        return add(sum,decimal(value));
      },decimal(0));
    const expected=div(mul(decimal(c.target),e),decimal(c.basisDays));
    const uncapped=div(mul(decimal(100),actual),expected);
    const capped=compare(uncapped,decimal(100))>0?decimal(100):uncapped;
    const contribution=div(mul(capped,decimal(c.weight)),totalWeight);
    return {measurement:structuredClone(recipe.measurement),target:structuredClone(recipe.targetCondition),
      weight:c.weight,mandatory:c.mandatory,actual,expected,uncapped,capped,contribution};
  });
  return {eligible:e,components,score:components.reduce((s,c)=>add(s,c.contribution),decimal(0))};
}
