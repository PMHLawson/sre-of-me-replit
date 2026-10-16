import { z } from "zod";
import type { DomainConfiguration, MeasurementDefinition, TypedCondition, QualificationPredicate } from "./domain-config";
/** Deliberately separate from the immutable seed-only contract. */
export type ComponentRecipe = {
  measurement: MeasurementDefinition;
  targetCondition: TypedCondition;
  weight: number;
  mandatory: boolean;
  percentage: "positive-linear-ratio-v1";
  actual: "sum-events" | "distinct-qualifying-days";
};
export type EvaluationRecipe = {
  recipeId: string; version: string;
  organizationId: string; ownerUserId: string; domainId: string; policyVersionId: string;
  targetId: string; targetSelection: "normal" | "adapted";
  qualification: QualificationPredicate | null;
  components: ComponentRecipe[];
};
export type EvaluationInput = {
  now: string; windowDays: number;
  policy: DomainConfiguration;
  observations: import("./domain-config").Observation[];
  coverage: { onboardingAt: string; policyStart: string; policyEnd: string };
  breaks: import("./evaluator-window").Interval[];
  recipe: EvaluationRecipe;
};
/**
 * Trusted embedding code supplies exact reviewed recipes, not caller-controlled
 * approval booleans. This capability is NOT authentication or owner consent.
 */
export type RecipeRegistry = readonly EvaluationRecipe[];
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0)
    .map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const id = z.string().min(1);
export const RecipeShape = z.object({
  recipeId:id,version:id,organizationId:id,ownerUserId:id,domainId:id,policyVersionId:id,
  targetId:id,targetSelection:z.enum(["normal","adapted"]),qualification:z.unknown(),
  components:z.array(z.object({
    measurement:z.object({measurementId:id}).passthrough(),
    targetCondition:z.object({measurementId:id}).passthrough(),weight:z.number().finite().positive(),
    mandatory:z.boolean(),percentage:z.literal("positive-linear-ratio-v1"),
    actual:z.enum(["sum-events","distinct-qualifying-days"]),
  }).strict()).min(1),
}).strict();
