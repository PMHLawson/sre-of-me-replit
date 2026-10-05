import { Router, json, type RequestHandler } from "express";
import { BoundaryError } from "../lib/org-context";
import { DomainInputError, type createDomainServiceV2 } from "../services/domain-service-v2";

type Service = ReturnType<typeof createDomainServiceV2>;
/** Management only: no migration, rollout control, scoring or authority supplied by callers. */
export function createPolicyV2Router(options: { service: Service; authenticate: RequestHandler }) {
  if (!options || typeof options.authenticate !== "function" || !options.service ||
    ["list", "read", "create", "configure"].some(key => typeof options.service[key as keyof Service] !== "function"))
    throw new BoundaryError(503);
  const router = Router();
  router.use(options.authenticate);
  router.use(json({ limit: "100kb", strict: true }));
  const handle = (status: number, operation: (request: any) => Promise<unknown>): RequestHandler => (request, response) => {
    void Promise.resolve().then(() => {
      if (Object.keys(request.query ?? {}).length > 0)
        throw new DomainInputError([{ path: "query", code: "unsupported_query", message: "This endpoint does not accept query parameters." }]);
      if (request.method === "GET" && request.body !== undefined)
        throw new DomainInputError([{ path: "body", code: "unexpected_body", message: "This read endpoint does not accept a request body." }]);
      return operation(request);
    }).then(value => response.status(status).json(value)).catch(error => {
      const safe = error instanceof BoundaryError ? error : new BoundaryError(503);
      response.status(safe.status).json({ message: safe.message,
        ...(safe instanceof DomainInputError ? { issues: safe.issues } : {}) });
    });
  };
  router.get("/", handle(200, request => options.service.list(request)));
  router.get("/:domainId", handle(200, request => options.service.read(request, request.params.domainId)));
  router.post("/", handle(201, request => options.service.create(request, request.body)));
  router.post("/:domainId/policies", handle(201, request => options.service.configure(request, request.params.domainId, request.body)));
  router.use((error: any, _request: any, response: any, _next: any) => {
    response.status(error?.status === 413 ? 413 : 400).json({ message: "Invalid request body" });
  });
  return router;
}
