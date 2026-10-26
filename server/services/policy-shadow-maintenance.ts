import type {Server} from "node:http";
import {BoundaryError} from "../lib/org-context";
import {isPolicyShadowService,type PolicyShadowService} from "./policy-shadow-capability";
import type {LegacyComparisonRequest} from "./legacy-activity-mutations";
// Server identity is the private invocation key; this does not mount an HTTP route.
const registrations=new WeakMap<Server,PolicyShadowService>();
export function registerPolicyShadowMaintenance(server:Server,service:PolicyShadowService):void{
  if(!server||typeof server!=="object"||!isPolicyShadowService(service))throw new BoundaryError(503);
  const prior=registrations.get(server);
  if(prior&&prior!==service)throw new BoundaryError(503);
  registrations.set(server,service);
}
export async function invokePolicyShadowMaintenance(server:Server,request:LegacyComparisonRequest){
  const service=registrations.get(server);
  if(!service)throw new BoundaryError(403);
  return service.run(request);
}
