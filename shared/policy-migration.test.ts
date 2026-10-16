import { describe,it,expect } from "vitest";
import { validateArtifacts,loadArtifacts,statements,QUERY_TEMPLATES,type MigrationArtifacts } from "../script/verify-policy-migration";

const original=loadArtifacts();
// Mutations operate on independent in-memory copies, never generated files.
const mutations: Array<[string,(a:MigrationArtifacts)=>void]> = [
  ["integer fractional eligibility",a=>{a.final.tables["public.evaluation_results"].columns.eligible_days.type="integer";}],
  ["fixed-scale eligibility",a=>{a.final.tables["public.evaluation_results"].columns.eligible_days.type="numeric(10,2)";}],
  ["nonfinite eligibility permitted",a=>{a.final.tables["public.evaluation_results"].checkConstraints.evaluation_eligible.value='"evaluation_results"."eligible_days">=0';}],
  ["negative eligibility permitted",a=>{a.final.tables["public.evaluation_results"].checkConstraints.evaluation_eligible.value=`"evaluation_results"."eligible_days"::text NOT IN ('NaN','Infinity','-Infinity')`;}],
  ["remove composite FK",a=>{delete a.final.tables["public.observations"].foreignKeys.observation_policy;}],
  ["mis-scope composite FK",a=>{a.final.tables["public.observations"].foreignKeys.observation_policy.columnsFrom=["policy_version_id"]; }],
  ["swap FK target order",a=>{a.final.tables["public.deviation_domains"].foreignKeys.deviation_domain_domain.columnsTo.reverse();}],
  ["cross-owner predecessor",a=>{a.final.tables["public.policy_versions"].foreignKeys.policy_predecessor.columnsFrom.splice(1,1);}],
  ["remove direct org FK",a=>{delete a.final.tables["public.domains"].foreignKeys.domains_org_id_organizations_org_id_fk;}],
  ["nullable tenant",a=>{a.final.tables["public.domains"].columns.org_id.notNull=false;}],
  ["cascading history",a=>{a.final.tables["public.observations"].foreignKeys.observation_policy.onDelete="cascade";}],
  ["remove uniqueness",a=>{delete a.final.tables["public.domains"].uniqueConstraints.domains_slug;}],
  ["remove idempotency uniqueness",a=>{delete a.final.tables["public.observations"].uniqueConstraints.observation_idempotency;}],
  ["remove check",a=>{delete a.final.tables["public.policy_versions"].checkConstraints.policy_configuration_identity;}],
  ["weaken JSON check",a=>{a.final.tables["public.observations"].checkConstraints.observation_identity.value="TRUE";}],
  ["remove rollout default",a=>{delete a.final.tables["public.organizations"].columns.rollout_mode.default;}],
  ["enable budget default",a=>{a.final.tables["public.evaluation_results"].columns.budget_enabled_snapshot.default=true;}],
  ["modify final legacy snapshot",a=>{a.final.tables["public.sessions"].columns.duration_minutes.notNull=false;}],
  ["modify BOTH legacy snapshots",a=>{a.final.tables["public.users"].columns.id.type="integer";a.baseline.tables["public.users"].columns.id.type="integer";}],
  ["executable baseline",a=>{a.baselineSql+="\nCREATE TABLE users(id text);";}],
  ["legacy CREATE in delta",a=>{a.deltaSql+='\nCREATE TABLE "sessions" ("id" text);';}],
  ["legacy ALTER in delta",a=>{a.deltaSql+='\nALTER TABLE "sessions" ADD COLUMN "bad" text;';}],
  ["DROP in delta",a=>{a.deltaSql+='\nDROP TABLE "users";';}],
  ["DML in delta",a=>{a.deltaSql+='\nDELETE FROM "observations";';}],
  ["dynamic SQL",a=>{a.deltaSql+="\nDO $$ BEGIN EXECUTE 'DROP TABLE users'; END $$;";}],
  ["trigger",a=>{a.deltaSql+='\nCREATE TRIGGER bad AFTER INSERT ON observations EXECUTE FUNCTION bad();';}],
  ["SQL missing FK",a=>{a.deltaSql=a.deltaSql.replace(/ALTER TABLE "observations" ADD CONSTRAINT "observation_policy"[^;]+;/,"");}],
  ["SQL missing check",a=>{a.deltaSql=a.deltaSql.replace(/CONSTRAINT "policy_revision_positive" CHECK \([^\n]+\),?/,"");}],
  ["SQL missing unique",a=>{a.deltaSql=a.deltaSql.replace(/CONSTRAINT "observation_idempotency" UNIQUE\([^\n]+\),?/,"");}],
  ["SQL wrong default",a=>{a.deltaSql=a.deltaSql.replace("DEFAULT 'legacy'","DEFAULT 'v2'");}],
  ["SQL changed JSON check",a=>{a.deltaSql=a.deltaSql.replace(/IS TRUE/g,"IS NOT FALSE");}],
  ["broken parent",a=>{a.final.prevId=a.final.id;}],
  ["bad journal tag",a=>{a.journal.entries[1].tag="other";}],
  ["bad journal index",a=>{a.journal.entries[1].idx=3;}],
  ["reversed journal time",a=>{a.journal.entries[1].when=a.journal.entries[0].when-1;}],
  ["extra migration",a=>{a.files.push("0002_unreviewed.sql");}],
  ["missing snapshot",a=>{a.files=a.files.filter(x=>!x.includes("0000_snapshot"));}],
];
describe("offline migration verifier: actual generated artifacts",()=>{
  it("accepts source/snapshot/SQL/journal consistency and zero next delta",async()=>{
    expect(await validateArtifacts(original)).toEqual({success:true,issues:[]});
  });
  it.each(mutations)("rejects %s",async(_name,mutate)=>{
    const copy=structuredClone(original),before=JSON.stringify(copy);
    mutate(copy);
    expect(JSON.stringify(copy)).not.toBe(before);
    const result=await validateArtifacts(copy);
    expect(result.success).toBe(false);expect(result.issues.length).toBeGreaterThan(0);
  });
  it("does not mutate input artifacts",async()=>{
    const before=JSON.stringify(original);await validateArtifacts(original);expect(JSON.stringify(original)).toBe(before);
  });
  it("lexes comments and quotes without concealing executable statements",()=>{
    expect(statements("-- comment\n/* nested /* inner */ ok */")).toEqual([]);
    expect(statements("SELECT 'a;--b'; SELECT \"a;b\";")).toHaveLength(2);
    expect(()=>statements("/* unfinished")).toThrow();
    expect(()=>statements("SELECT 'unfinished")).toThrow();
    expect(statements("-- harmless\nDELETE FROM users;")).toEqual(["DELETE FROM users"]);
  });
  it("provides nonexecuting ownership/reconciliation templates with future mapping gate",()=>{
    expect(QUERY_TEMPLATES).toContain("PRINT ONLY");
    expect(QUERY_TEMPLATES).toContain("s.user_id IS NULL");
    expect(QUERY_TEMPLATES).toContain("deleted_duration_total");
    expect(QUERY_TEMPLATES).toContain("edit_count");
    expect(QUERY_TEMPLATES).toContain("SOMR-431");
    expect(QUERY_TEMPLATES).not.toMatch(/\b(?:INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|DROP TABLE)\b/i);
  });
});