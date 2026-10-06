import { Router, json, type RequestHandler } from "express";
import { ActivityCreateInputSchema, ActivityIdSchema, ActivityListInputSchema, ActivitySubmissionKeySchema } from "../../shared/activity";
import { authenticatedBootstrapActor } from "../lib/authenticated-bootstrap-unit";
import { BoundaryError } from "../lib/org-context";
import { ActivityInputError, parseActivityInput, type createActivityServiceV2 } from "../services/activity-service-v2";

type Service = ReturnType<typeof createActivityServiceV2>;
export function createActivityV2Router(options: { service: Service; authenticate: RequestHandler }) {
  if (!options || typeof options.authenticate !== "function" || !options.service ||
    ["create", "read", "submission", "list", "eligibility"].some(key => typeof options.service[key as keyof Service] !== "function"))
    throw new BoundaryError(503);
  const router = Router();
  router.use(options.authenticate);
  router.use((request, response, next) => {
    try { authenticatedBootstrapActor(request); next(); }
    catch { response.status(401).json({ message: "Authentication required" }); }
  });
  router.use(json({ limit: "16kb", strict: true }));
  // The application also has an outer JSON parser. Enforce this endpoint's
  // bound even when that parser has already consumed the body.
  router.use((request, response, next) => {
    const declared = Number(request.headers["content-length"] ?? 0);
    let bytes = 0;
    try { if (request.body !== undefined) bytes = Buffer.byteLength(JSON.stringify(request.body), "utf8"); }
    catch { response.status(400).json({ message: "Invalid request body" }); return; }
    if (declared > 16384 || bytes > 16384) {
      response.setHeader("Cache-Control", "no-store"); response.status(413).json({ message: "Invalid request body" }); return;
    }
    next();
  });
  const handle = (operation: (request: any) => Promise<unknown>, creation = false): RequestHandler => (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    void Promise.resolve().then(() => {
      if (request.method === "GET" && (request.body !== undefined || request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) > 0))
        throw new ActivityInputError([{ path: "body", code: "unexpected_body" }]);
      return operation(request);
    }).then(value => response.status(creation && (value as { created?: unknown })?.created === true ? 201 : 200).json(value))
      .catch(error => {
        const safe = error instanceof BoundaryError ? error : new BoundaryError(503);
        response.status(safe.status).json({ message: safe.message, ...(safe instanceof ActivityInputError ? { issues: safe.issues } : {}) });
      });
  };
  const noQuery = (request: any) => {
    if (Object.keys(request.query ?? {}).length) throw new ActivityInputError([{ path: "query", code: "unsupported_query" }]);
  };
  router.get("/eligibility/:domainId", handle(request => {
    noQuery(request); return options.service.eligibility(request, parseActivityInput(ActivityIdSchema, request.params.domainId));
  }));
  router.get("/submissions/:submissionKey", handle(request => {
    noQuery(request); return options.service.submission(request, parseActivityInput(ActivitySubmissionKeySchema, request.params.submissionKey));
  }));
  router.get("/:activityId", handle(request => {
    noQuery(request); return options.service.read(request, parseActivityInput(ActivityIdSchema, request.params.activityId));
  }));
  router.get("/", handle(request => {
    const q = request.query ?? {};
    if (Object.keys(q).some(key => !["domainId", "limit", "cursor"].includes(key)) ||
      Object.values(q).some(value => typeof value !== "string") ||
      (q.limit !== undefined && !/^[1-9]\d{0,2}$/.test(q.limit)))
      throw new ActivityInputError([{ path: "query", code: "invalid_query" }]);
    return options.service.list(request, parseActivityInput(ActivityListInputSchema, {
      ...(q.domainId !== undefined ? { domainId: q.domainId } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}), ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
    }));
  }));
  router.post("/", handle(request => {
    noQuery(request); return options.service.create(request, parseActivityInput(ActivityCreateInputSchema, request.body));
  }, true));
  router.use((error: any, _request: any, response: any, _next: any) => {
    response.setHeader("Cache-Control", "no-store");
    response.status(error?.status === 413 ? 413 : 400).json({ message: "Invalid request body" });
  });
  return router;
}
