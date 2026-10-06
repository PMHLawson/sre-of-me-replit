import { Router, json, type RequestHandler } from "express";
import { WorkspaceEnsureInputSchema, OnboardingSettingsPatchSchema } from "../../shared/onboarding";
import { BoundaryError } from "../lib/org-context";
import { authenticatedBootstrapActor } from "../lib/authenticated-bootstrap-unit";
import type { createPersonalWorkspaceService } from "../services/personal-workspace-service";

type Service = ReturnType<typeof createPersonalWorkspaceService>;
/** Authenticated personal setup only; no caller-selected organization or template. */
export function createOnboardingRouter(options: { service: Service; authenticate: RequestHandler }) {
  if (!options || typeof options.authenticate !== "function" || !options.service ||
    typeof options.service.status !== "function" || typeof options.service.ensure !== "function" ||
    typeof options.service.updateSettings !== "function" || typeof options.service.readSettings !== "function") throw new BoundaryError(503);
  const router = Router();
  router.use(options.authenticate);
  // Preserve zero DB access for forged/throwing Passport claims, even if an
  // injected authentication middleware incorrectly calls next().
  router.use((request, response, next) => {
    try { authenticatedBootstrapActor(request); next(); }
    catch { response.status(401).json({ message: "Authentication required" }); }
  });
  router.use(json({ limit: "1kb", strict: true }));
  const handle = (operation: (request: any) => Promise<unknown>): RequestHandler => (request, response) => {
    void Promise.resolve().then(() => {
      if (Object.keys(request.query ?? {}).length > 0 ||
        (request.method === "GET" && request.body !== undefined)) throw new BoundaryError(400);
      return operation(request);
    }).then(value => {
      response.set("Cache-Control", "no-store"); response.status(200).json(value);
    }).catch(error => {
      const safe = error instanceof BoundaryError ? error : new BoundaryError(503);
      response.set("Cache-Control", "no-store"); response.status(safe.status).json({ message: safe.message });
    });
  };
  router.get("/status", handle(request => options.service.status(request)));
  router.get("/settings", handle(request => options.service.readSettings(request)));
  router.post("/workspace", handle(request => {
    if (!WorkspaceEnsureInputSchema.safeParse(request.body).success) throw new BoundaryError(400);
    return options.service.ensure(request, request.body);
  }));
  router.patch("/settings", handle(request => {
    if (!OnboardingSettingsPatchSchema.safeParse(request.body).success) throw new BoundaryError(400);
    return options.service.updateSettings(request, request.body);
  }));
  router.use((error: any, _request: any, response: any, _next: any) => {
    response.set("Cache-Control", "no-store");
    response.status(error?.status === 413 ? 413 : 400).json({ message: "Invalid request body" });
  });
  return router;
}
