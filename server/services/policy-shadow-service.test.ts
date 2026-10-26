import {describe,it,expect,vi} from "vitest";
import {createServer} from "node:http";
import {readFileSync} from "node:fs";
import {createPolicyShadowService,classifyPolicyShadowDifferences,ExpectedDifferenceRuleSchema,
  PolicyShadowReportSchema,type ComparisonScope,type ExpectedDifferenceRule} from "./policy-shadow-service";
import {registerPolicyShadowMaintenance,invokePolicyShadowMaintenance} from "./policy-shadow-maintenance";
import {reportPolicyShadow} from "../../script/report-policy-shadow";
const scope:ComparisonScope={organizationId:"fixture-org",ownerUserId:"fixture-owner",domainId:"fixture-domain",
  policyVersionId:"fixture-policy",policyFingerprint:"1".repeat(64),recipeId:"fixture-recipe",recipeVersion:"1",
  recipeFingerprint:"2".repeat(64),sourceFingerprint:"3".repeat(64),asOf:"2026-01-15T12:00:00.000Z",
  windowStart:"2026-01-08T00:00:00.000Z",windowEnd:"2026-01-15T00:00:00.000Z",windowDays:7,
  boundary:{timezone:"UTC",dayStartHour:0}};
const rule:ExpectedDifferenceRule={ruleId:"synthetic-full-precision-health",version:"1",
  decisionCitation:"docs/step9-measurement-rules.md#approved-health-and-overachievement-arithmetic",
  scope,metric:"health_score",legacy:52,next:360/7};
describe("private shadow classification",()=>{
  it("matches health to health and preserves full precision rather than rounded display",()=>{
    expect(classifyPolicyShadowDifferences(scope,[{metric:"health_score",legacy:52,next:360/7}],[]))
      .toMatchObject([{outcome:"DEFECT",reason:"unclassified_difference",legacy:52,next:360/7}]);
    expect(classifyPolicyShadowDifferences(scope,[{metric:"health_score",legacy:90,next:89.9999}],[])).toHaveLength(1);
    expect(classifyPolicyShadowDifferences(scope,[{metric:"health_score",legacy:52,next:52}],[])).toEqual([]);
  });
  it("accepts exactly one reviewed exact-scope independently specified rule",()=>{
    expect(classifyPolicyShadowDifferences(scope,[{metric:"health_score",legacy:52,next:360/7}],[rule]))
      .toMatchObject([{outcome:"EXPECTED-DESIGN-CHANGE",ruleId:rule.ruleId,ruleVersion:"1",reason:"exact_reviewed_rule"}]);
  });
  it.each(["sourceFingerprint","organizationId","ownerUserId","domainId","policyVersionId","policyFingerprint",
    "recipeId","recipeVersion","recipeFingerprint","asOf","windowStart","windowEnd","windowDays","boundary"] as const)(
    "a changed %s falls outside the rule",key=>{
      const changed=structuredClone(scope) as any;
      changed[key]=key==="windowDays"?14:key==="boundary"?{timezone:"America/New_York",dayStartHour:4}:
        key.toLowerCase().includes("fingerprint")?"9".repeat(64):key==="asOf"||key.startsWith("window")?"2026-01-16T00:00:00.000Z":"different";
      expect(classifyPolicyShadowDifferences(changed,[{metric:"health_score",legacy:52,next:360/7}],[rule])[0].outcome).toBe("DEFECT");
    });
  it("an unrelated extra difference and a changed expected value are defects",()=>{
    const result=classifyPolicyShadowDifferences(scope,[
      {metric:"health_score",legacy:52,next:360/7},{metric:"actual_minutes",legacy:30,next:31}],[rule]);
    expect(result.map(r=>r.outcome)).toEqual(["EXPECTED-DESIGN-CHANGE","DEFECT"]);
    expect(classifyPolicyShadowDifferences(scope,[{metric:"health_score",legacy:52,next:51}],[rule])[0].outcome).toBe("DEFECT");
  });
  it("ambiguous matching rules remain a defect",()=>{
    expect(classifyPolicyShadowDifferences(scope,[{metric:"health_score",legacy:52,next:360/7}],
      [rule,{...rule,ruleId:"second-decision"}])[0]).toMatchObject({outcome:"DEFECT",reason:"ambiguous_rules",ruleId:null});
  });
  it("rule declarations require citation/version/exact scope and reject executable catchalls",()=>{
    for(const invalid of [{...rule,version:""},{...rule,decisionCitation:""},{...rule,scope:{domainId:"*"}},
      {...rule,predicate:()=>true},{...rule,metric:"error_budget_percent"}])
      expect(ExpectedDifferenceRuleSchema.safeParse(invalid).success).toBe(false);
  });
  it("disabled construction and invocation do no provider or database work",async()=>{
    const options:any={enabled:false};
    for(const key of ["unit","history","recipes","expectedDifferences"])Object.defineProperty(options,key,{get(){throw Error("unexpected dependency access");}});
    expect(await createPolicyShadowService(options).run({})).toEqual({status:"disabled"});
    expect(await createPolicyShadowService().run({})).toEqual({status:"disabled"});
  });
  it("rejects a forged comparison unit before accepting a provider",()=>{
    const run=vi.fn();
    expect(()=>createPolicyShadowService({enabled:true,unit:{run} as any,history:vi.fn(),recipes:[],
      calculationVersion:"fixture-v1",expectedDifferences:[]})).toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
describe("explicit maintenance registration",()=>{
  it("has no default invocation; only an authentic constructed service can be registered",async()=>{
    const server=createServer();
    await expect(invokePolicyShadowMaintenance(server,{})).rejects.toMatchObject({status:403});
    expect(()=>registerPolicyShadowMaintenance(server,{run:async()=>({status:"disabled"})} as any)).toThrow();
    const service=createPolicyShadowService();registerPolicyShadowMaintenance(server,service);
    registerPolicyShadowMaintenance(server,service);
    expect(await invokePolicyShadowMaintenance(server,{})).toEqual({status:"disabled"});
    expect(JSON.parse(await reportPolicyShadow(server,{}))).toEqual({status:"disabled"});
    expect(()=>registerPolicyShadowMaintenance(server,createPolicyShadowService())).toThrow();
  });
  it("route injection stores a private capability without changing the ordinary current handlers",()=>{
    const source=readFileSync(new URL("../routes.ts",import.meta.url),"utf8");
    expect(source).toContain("policyShadowMaintenance?: PolicyShadowService");
    const maintenance=readFileSync(new URL("./policy-shadow-maintenance.ts",import.meta.url),"utf8");
    const capability=readFileSync(new URL("./policy-shadow-capability.ts",import.meta.url),"utf8");
    expect(maintenance).not.toContain('from "./policy-shadow-service"');
    expect(capability.replace(/^import\s+type[\s\S]*?;\s*/gm,"")).not.toMatch(/from\s*["\']/);
    expect(capability).not.toContain("createEvaluator");
    expect(capability).not.toContain("createEvaluationPersistence");
    expect(source).toContain("registerPolicyShadowMaintenance(httpServer,policyShadowMaintenance)");
    expect(source).not.toContain("invokePolicyShadowMaintenance");
    expect(source).not.toMatch(/app\.(get|post|put|patch|delete)\([^\n]*(shadow|reconcil)/i);
    expect(source).toContain("res.json(policyResponse(await historyReads.current(userId,14)))");
    expect(source).toContain("res.json(stateBundle(await historyReads.current(userId,days),days))");
    expect(PolicyShadowReportSchema.safeParse({status:"completed",rows:[],notes:"private"}).success).toBe(false);
  });
});
