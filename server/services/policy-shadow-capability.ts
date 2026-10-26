import type {LegacyComparisonRequest} from "./legacy-activity-mutations";
import type {PolicyShadowRun} from "./policy-shadow-service";
export type PolicyShadowService=Readonly<{run:(request:LegacyComparisonRequest)=>Promise<PolicyShadowRun>}>;
const services=new WeakSet<object>();
/**
 * Internal issuer used only by the validated explicit shadow factory.
 * Kept separate so the ordinary server imports no scoring/history/write engine.
 */
export function issuePolicyShadowService(run:PolicyShadowService["run"]):PolicyShadowService{
  if(typeof run!=="function")throw Error("invalid_shadow_capability");
  const service=Object.freeze({run});services.add(service);return service;
}
export function isPolicyShadowService(value:unknown):value is PolicyShadowService{
  return !!value&&typeof value==="object"&&services.has(value);
}
