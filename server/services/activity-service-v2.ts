import { z } from "zod";
import { ActivityCreateInputSchema, ActivityIdSchema, ActivitySubmissionKeySchema,
  ActivityListInputSchema, ActivityCreateResultSchema, ActivityViewSchema, ActivityListResultSchema, ActivityEligibilitySchema,
  ActivityEditInputSchema,ActivityLifecycleInputSchema,ActivityMutationResultSchema,ActivitySubmissionResultSchema } from "../../shared/activity";
import { authenticatedBootstrapActor } from "../lib/authenticated-bootstrap-unit";
import { BoundaryError } from "../lib/org-context";
import type { createPinnedOwnershipUnit } from "../lib/pinned-ownership-unit";
import { createPolicyV2Storage } from "../storage/policy-v2-storage";

type Unit = ReturnType<typeof createPinnedOwnershipUnit>;
type Request = Parameters<Unit["run"]>[0];
const editRouteSchema=z.object({activityId:ActivityIdSchema,input:ActivityEditInputSchema}).strict();
const lifecycleRouteSchema=z.object({activityId:ActivityIdSchema,input:ActivityLifecycleInputSchema}).strict();
const mutationRouteSchema=z.object({activityId:ActivityIdSchema,mutationKey:ActivityIdSchema}).strict();
export class ActivityInputError extends BoundaryError {
  constructor(public readonly issues: readonly { path: string; code: string }[]) { super(400); }
}
export function parseActivityInput<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ActivityInputError(result.error.issues.slice(0, 32).map(issue => ({ path: issue.path.join("."), code: issue.code })));
  return result.data;
}
/** Existing original Passport request, one checked-out ownership unit, no default connection. */
export function createActivityServiceV2(unit: Unit, options: { clock?: () => Date } = {}) {
  if (!unit || typeof unit.run !== "function" || !options || typeof options !== "object" ||
    Object.keys(options).some(key => key !== "clock") || (Object.hasOwn(options, "clock") && typeof options.clock !== "function"))
    throw new BoundaryError(503);
  async function perform<S extends z.ZodTypeAny, R extends z.ZodTypeAny>(request: Request, schema: S, input: unknown, output: R,
    operation: (store: ReturnType<typeof createPolicyV2Storage>, parsed: z.infer<S>) => Promise<unknown>): Promise<z.infer<R>> {
    authenticatedBootstrapActor(request); // Authentication precedes validation and lazy connection.
    const parsed = parseActivityInput(schema, input);
    return unit.run(request, async ownership => {
      const result = output.safeParse(await operation(createPolicyV2Storage(ownership.db, ownership.context, options), parsed));
      if (!result.success) throw new BoundaryError(503);
      return result.data;
    });
  }
  return Object.freeze({
    edit:(request:Request,key:unknown,input:unknown)=>perform(request,editRouteSchema,{activityId:key,input},ActivityMutationResultSchema,
      (store,value)=>store.personalPractice.edit(value.activityId,value.input)),
    delete:(request:Request,key:unknown,input:unknown)=>perform(request,lifecycleRouteSchema,{activityId:key,input},ActivityMutationResultSchema,
      (store,value)=>store.personalPractice.delete(value.activityId,value.input)),
    restore:(request:Request,key:unknown,input:unknown)=>perform(request,lifecycleRouteSchema,{activityId:key,input},ActivityMutationResultSchema,
      (store,value)=>store.personalPractice.restore(value.activityId,value.input)),
    mutation:(request:Request,key:unknown,mutationKey:unknown)=>perform(request,mutationRouteSchema,{activityId:key,mutationKey},ActivityMutationResultSchema,
      (store,value)=>store.personalPractice.mutation(value.activityId,value.mutationKey)),
    eligibility: (request: Request, input: unknown) => perform(request, ActivityIdSchema, input, ActivityEligibilitySchema,
      (store, value) => store.personalPractice.eligibility(value)),
    create: (request: Request, input: unknown) => perform(request, ActivityCreateInputSchema, input, ActivityCreateResultSchema,
      (store, value) => store.personalPractice.create(value)),
    read: (request: Request, input: unknown) => perform(request, ActivityIdSchema, input, ActivityViewSchema,
      (store, value) => store.personalPractice.read(value)),
    submission: (request: Request, input: unknown) => perform(request, ActivitySubmissionKeySchema, input, ActivitySubmissionResultSchema,
      (store, value) => store.personalPractice.submission(value)),
    list: (request: Request, input: unknown = {}) => perform(request, ActivityListInputSchema, input, ActivityListResultSchema,
      (store, value) => store.personalPractice.list(value)),
  });
}
