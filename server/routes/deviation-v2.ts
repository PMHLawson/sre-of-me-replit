import { Router, json, type RequestHandler } from "express";
import { BoundaryError } from "../lib/org-context";
import { ResourceLimitError } from "../lib/read-budget";
import { WriteResourceLimitError } from "../lib/write-resource-budget";
import type { createDeviationServiceV2 } from "../services/deviation-service-v2";

type Service = ReturnType<typeof createDeviationServiceV2>;

/** Owner-scoped break lifecycle; no scoring or rollout controls are exposed. */
export function createDeviationV2Router(options: { service: Service; authenticate: RequestHandler }) {
  if (!options || typeof options.authenticate !== "function" || !options.service ||
      ["list", "read", "create", "edit", "end", "softDelete"].some(key =>
        typeof options.service[key as keyof Service] !== "function"))
    throw new BoundaryError(503);
  const router = Router();
  router.use(options.authenticate);
  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(json({ limit: "100kb", strict: true }));
  const handle = (status: number, operation: (request: any) => Promise<unknown>): RequestHandler => (request, response) => {
    void Promise.resolve().then(() => {
      if (Object.keys(request.query ?? {}).length > 0)
        throw new BoundaryError(400);
      return operation(request);
    }).then(value => response.status(status).json(value)).catch(error => {
      const safe = error instanceof BoundaryError ? error : new BoundaryError(503);
      if (safe instanceof WriteResourceLimitError && safe.retryAfterSeconds !== null)
        response.setHeader("Retry-After", String(safe.retryAfterSeconds));
      response.status(safe.status).json({
        message: safe.message,
        ...(safe instanceof WriteResourceLimitError ? { code: safe.code, retryAfterSeconds: safe.retryAfterSeconds } : {}),
        ...(safe instanceof ResourceLimitError ? { code: safe.code } : {}),
      });
    });
  };
  router.get("/", handle(200, request => options.service.list(request)));
  router.get("/:deviationId", handle(200, request => options.service.read(request, request.params.deviationId)));
  router.post("/", handle(201, request => options.service.create(request, request.body)));
  router.patch("/:deviationId", handle(200, request =>
    options.service.edit(request, request.params.deviationId, request.body)));
  router.post("/:deviationId/end", handle(200, request =>
    options.service.end(request, request.params.deviationId, request.body ?? {})));
  router.delete("/:deviationId", handle(200, request =>
    options.service.softDelete(request, request.params.deviationId, request.body ?? {})));
  router.use((error: any, _request: any, response: any, _next: any) => {
    response.status(error?.status === 413 ? 413 : 400).json({ message: "Invalid request body" });
  });
  return router;
}
