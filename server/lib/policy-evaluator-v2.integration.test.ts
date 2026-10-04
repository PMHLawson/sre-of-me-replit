/**
 * Intentional A1.2 collection RED: missing future evaluator is the ONLY expected
 * failure. Static import, no stub, skip, conditional import or replacement.
 * Only feasible RAW_CASES enter this suite. A1.3 persistence derivation, trend,
 * resolved cross-ladder state and service policy selection are NOT asserted.
 */
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "./policy-evaluator-v2";
import { RAW_CASES } from "./fixtures/policy-v2-cases";
import { ATTENTION_MAP, SEED_DIMENSIONS, type ScoredEvaluation } from "@shared/policy-contract-v2";

describe.each(RAW_CASES)("A1.2 raw evaluator $id", c => {
  it("derives expectations, proration, buckets, Today, components, guardrails and evidence from raw input", async () => {
    const result: ScoredEvaluation = await evaluatePolicy(c.input);
    const x=c.expected;
    expect(result.domain).toBe(c.input.domain);
    expect(result.windowDays).toBe(c.input.windowDays);
    expect(result.policyVersion).toEqual(c.input.policy.version);
    expect(result.calculationVersion).toBe(c.input.policy.version.calculationVersion);
    expect(result.boundary).toEqual(c.input.boundary);
    expect(result.eligibleWindowBasis).toBeCloseTo(x.eligibleDays,9);
    expect(result.proration.baseDays).toBe(c.input.policy.baseDays);
    expect(result.proration.windowDays).toBe(c.input.windowDays);
    expect(result.proration.eligibleDays).toBeCloseTo(x.eligibleDays,9);
    expect(result.blockProration).toHaveLength(x.blocks.length);
    for (const block of x.blocks) {
      const got=result.blockProration.find(b=>b.blockId===block.blockId);
      expect(got).toBeDefined();
      expect(got!.startAt).toBe(block.startAt);
      expect(got!.endAt).toBe(block.endAt);
      expect(got!.deviatedFraction).toBeCloseTo(block.deviatedFraction,9);
    }
    expect(result.componentEvidence).toHaveLength(2);
    for (const k of ["duration","frequency"] as const) {
      expect(result.actual[k]).toBeCloseTo(x.actual[k],9);
      expect(result.expected[k]).toBeCloseTo(x.targets[k],9);
      const component=result.componentEvidence.find(e=>e.dimensionId===k);
      expect(component).toBeDefined();
      expect(component!.actual).toBeCloseTo(x.actual[k],9);
      expect(component!.expected).toBeCloseTo(x.targets[k],9);
      expect(component!.rawScore).toBeCloseTo(x.outcome.raw[k],9);
      expect(component!.cappedScore).toBeCloseTo(x.outcome.capped[k],9);
      expect(component!.weight).toBe(SEED_DIMENSIONS[k].weight);
      expect(component!.isMandatory).toBe(SEED_DIMENSIONS[k].mandatory);
      expect(component!.isZero).toBe(x.actual[k]===0);
    }
    expect(result.domainScore).toBeCloseTo(x.outcome.score,9);
    expect(result.conditionBand).toBe(x.outcome.condition);
    expect(result.attentionLevel).toBe(ATTENTION_MAP[x.outcome.condition]);
    expect(result.guardrailFired).toBe(x.outcome.guardrailDimensions.length>0);
    expect([...result.guardrailDimensions].sort()).toEqual([...x.outcome.guardrailDimensions].sort());
    for (const k of x.outcome.guardrailDimensions) expect(result.guardrailReason?.toLowerCase()).toContain(k);
    expect(result.overachievementRaw).toBeCloseTo(x.outcome.overachievementRaw,9);
    expect(result.overachievementTier).toBe(x.outcome.tier);
    expect(result.sourceBinding).toEqual(c.input.provenance);
    expect([...result.consumedObservationIds].sort()).toEqual([...x.consumedIds].sort());
    expect([...result.excludedObservationIds].sort()).toEqual([...x.excludedIds].sort());
    expect([...result.today.observationIds].sort()).toEqual([...x.todayIds].sort());
    expect(result.today.durationMinutes).toBeCloseTo(x.todayMinutes,9);
  });
});