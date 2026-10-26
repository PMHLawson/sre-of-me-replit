import type {Server} from "node:http";
import type {LegacyComparisonRequest} from "../server/services/legacy-activity-mutations";
import {invokePolicyShadowMaintenance} from "../server/services/policy-shadow-maintenance";
import {PolicyShadowReportSchema} from "../server/services/policy-shadow-service";
/**
 * Internal, dependency-injected report function only. No CLI, connection,
 * environment lookup, public endpoint, startup job or default invocation.
 * Authentication and reconciliation occur again inside each enabled run.
 */
export async function reportPolicyShadow(server:Server,request:LegacyComparisonRequest):Promise<string>{
  const report=await invokePolicyShadowMaintenance(server,request);
  if(report.status==="completed")PolicyShadowReportSchema.parse(report);
  return JSON.stringify(report,null,2);
}
