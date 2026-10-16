import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage, historyReads } from "./storage";
import { createLegacyDeviationMutations } from "./services/legacy-deviation-mutations";
import { ResourceLimitError } from "./lib/read-budget";
import { WriteResourceLimitError } from "./lib/write-resource-budget";
import { BoundaryError } from "./lib/org-context";
import { HistoryInputError, HistoryNotFound, HistoryChanged, parseHistoryPage, historyDays } from "./lib/legacy-history";
import { policyResponse, stateBundle } from "./lib/history-state";
import { createLegacySessionAdapter, readLegacyWriteThroughConfig, type LegacySessionAdapter } from "./services/legacy-session-adapter";
import {
  insertSessionSchema,
  updateSessionSchema,
  insertDeviationSchema,
  updateDeviationSchema,
  deviationLifecycleSchema,
  anomalyCheckRequestSchema,
  insertUserSettingsSchema,
} from "@shared/schema";
import { isAuthenticated } from "./replit_integrations/auth";
import { authStorage } from "./replit_integrations/auth/storage";
import { createPolicyV2Router } from "./routes/policy-v2";
import { createDomainServiceV2 } from "./services/domain-service-v2";
import { createPinnedOwnershipUnit } from "./lib/pinned-ownership-unit";
import { createAuthenticatedBootstrapUnit } from "./lib/authenticated-bootstrap-unit";
import { createPersonalWorkspaceService } from "./services/personal-workspace-service";
import { createOnboardingRouter } from "./routes/onboarding";
import { createActivityServiceV2 } from "./services/activity-service-v2";
import { createActivityV2Router } from "./routes/activity-v2";
import {
  computeCompositeState,
  isInRampUp,
  computeSustainedOverachievement,
  completedWindowDays,
  logicalDay,
  logicalDayStartUtc,
} from "./lib/policy-engine";
import { computeEscalationState } from "./lib/escalation";
import { detectAnomaly, computeBaseline, BASELINE_DAYS, COLD_START_THRESHOLD } from "./lib/anomaly";
import { domainEnum } from "@shared/schema";

export async function registerRoutes(
  httpServer: Server,
  app: Express,
  sessionMutations: LegacySessionAdapter = createLegacySessionAdapter({
    config: readLegacyWriteThroughConfig(process.env),
    getPool: async () => (await import("./db")).pool,
  }),
  deviationMutations = createLegacyDeviationMutations(createAuthenticatedBootstrapUnit({
    connect: async () => (await import("./db")).pool.connect(),
  })),
): Promise<Server> {
  app.use("/api/v2/activities", createActivityV2Router({
    authenticate: isAuthenticated,
    service: createActivityServiceV2(createPinnedOwnershipUnit({
      connect: async () => (await import("./db")).pool.connect(),
    })),
  }));

  app.use("/api/onboarding", createOnboardingRouter({
    authenticate: isAuthenticated,
    service: createPersonalWorkspaceService(createAuthenticatedBootstrapUnit({
      connect: async () => (await import("./db")).pool.connect(),
    })),
  }));

  // Original Passport authentication runs before the lazy pool connection.
  // Management uses the existing ownership transaction; no caller supplies authority.
  app.use("/api/v2/domains", createPolicyV2Router({
    authenticate: isAuthenticated,
    service: createDomainServiceV2(createPinnedOwnershipUnit({
      connect: async () => (await import("./db")).pool.connect(),
    })),
  }));

  // Complete current context and both derived payloads share one snapshot,
  // one clock and one settings version; no client joins unrelated generations.
  app.get("/api/session-state",isAuthenticated,async(req:any,res)=>{
    res.setHeader("Cache-Control","no-store");
    try{
      const days=historyDays(req.query),userId:string=req.user.claims.sub;
      res.json(stateBundle(await historyReads.current(userId,days),days));
    }catch(error){respondHistoryError(error,res);}
  });
  app.get("/api/sessions",isAuthenticated,async(req:any,res)=>{
    res.setHeader("Cache-Control","no-store");
    try{res.json(await historyReads.page(req.user.claims.sub,"sessions",parseHistoryPage(req.query)));}
    catch(error){respondHistoryError(error,res);}
  });
  app.get("/api/sessions/context",isAuthenticated,async(req:any,res)=>{
    res.setHeader("Cache-Control","no-store");
    try{
      if(Object.keys(req.query).length)throw new HistoryInputError();
      const userId:string=req.user.claims.sub;
      const input=await historyReads.current(userId,14);
      res.json({asOf:input.now.toISOString(),sessions:input.context,deviations:input.contextDeviations,
        fromInclusive:input.fromInclusive,complete:true});
    }catch(error){respondHistoryError(error,res);}
  });
  // Compatible successful derived payloads remain available to existing callers.
  app.get("/api/policy-state",isAuthenticated,async(req:any,res)=>{
    res.setHeader("Cache-Control","no-store");
    try{
      if(Object.keys(req.query).length)throw new HistoryInputError();
      const userId:string=req.user.claims.sub;
      res.json(policyResponse(await historyReads.current(userId,14)));
    }catch(error){respondHistoryError(error,res);}
  });
  app.get("/api/escalation-state",isAuthenticated,async(req:any,res)=>{
    res.setHeader("Cache-Control","no-store");
    try{
      const days=historyDays(req.query),userId:string=req.user.claims.sub;
      const input=await historyReads.current(userId,days);
      res.json(computeEscalationState(input.sessions,input.opts,days));
    }catch(error){respondHistoryError(error,res);}
  });

  // GET /api/settings — current user's settings (auto-created with defaults on first access).
  app.get("/api/settings", isAuthenticated, async (req: any, res) => {
    try {
      const userId: string = req.user.claims.sub;
      const settings = await storage.getUserSettings(userId);
      res.json(settings);
    } catch (error) {
      if (respondWriteError(error,res)) return;
      if (error instanceof ResourceLimitError) return respondHistoryError(error,res);
      res.status(500).json({ message: "Failed to fetch settings" });
    }
  });

  // PATCH /api/settings — update a subset of the user's settings.
  app.patch("/api/settings", isAuthenticated, async (req: any, res) => {
    const parsed = insertUserSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid settings", errors: parsed.error.flatten() });
    }
    try {
      const userId: string = req.user.claims.sub;
      const row = await storage.upsertUserSettings(userId, parsed.data);
      res.json(row);
    } catch (error) {
      if (respondWriteError(error,res)) return;
      if (error instanceof ResourceLimitError) return respondHistoryError(error,res);
      res.status(500).json({ message: "Failed to update settings" });
    }
  });

  // POST /api/sessions — log a new session for the authenticated user
  app.post("/api/sessions", isAuthenticated, async (req: any, res) => {
    const parsed = insertSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid session data", errors: parsed.error.flatten() });
    }
    // Server-side guard: an anomaly note is required whenever isAnomaly is true.
    if (parsed.data.isAnomaly && !parsed.data.anomalyNote?.trim()) {
      return res.status(400).json({ message: "Anomaly note is required when isAnomaly is true" });
    }
    try {
      const userId: string = req.user.claims.sub;
      const synchronized = await sessionMutations.create(req, {
        domain: parsed.data.domain, durationMinutes: parsed.data.durationMinutes,
        timestamp: parsed.data.timestamp, ...(parsed.data.notes === undefined ? {} : { notes: parsed.data.notes }),
        ...(parsed.data.isAnomaly === undefined ? {} : { isAnomaly: parsed.data.isAnomaly }),
        ...(parsed.data.anomalyNote === undefined ? {} : { anomalyNote: parsed.data.anomalyNote }),
      });
      if (synchronized !== undefined) return res.status(201).json(synchronized);
      const session = await storage.createSession({
        ...parsed.data,
        userId,
        isAnomaly: parsed.data.isAnomaly ?? false,
        anomalyNote: parsed.data.isAnomaly ? (parsed.data.anomalyNote ?? null) : null,
      });
      res.status(201).json(serializeSession(session));
    } catch (error) {
      if (respondWriteError(error,res)) return;
      if (error instanceof ResourceLimitError) return respondHistoryError(error,res);
      if (sessionMutations.respondError(error, res, "create")) return;
      res.status(500).json({ message: "Failed to create session" });
    }
  });

  // POST /api/sessions/anomaly-check — preview whether a candidate duration is
  // a 2-sigma anomaly given the user's 42-day baseline for the domain. Pure
  // read; does not persist anything. Used by Log Session before save.
  app.post("/api/sessions/anomaly-check", isAuthenticated, async (req: any, res) => {
    const parsed = anomalyCheckRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid anomaly-check request", errors: parsed.error.flatten() });
    }
    try {
      const userId: string = req.user.claims.sub;
      // Scope the fetch to the 42-day baseline window the detector cares
      // about. detectAnomaly will still apply the same cutoff defensively,
      // but pre-filtering at the DB layer keeps payloads small for users
      // with long histories.
      const now = new Date();
      const sessions = await historyReads.baseline(userId, now, parsed.data.domain, parsed.data.excludeSessionId);
      // The edited row is not one of its own historical peers. Exclusion is
      // applied only to this already user-scoped, active history collection.
      const peers = parsed.data.excludeSessionId
        ? sessions.filter(session => session.id !== parsed.data.excludeSessionId)
        : sessions;
      const result = detectAnomaly(parsed.data.domain, parsed.data.durationMinutes, peers, { now });
      // JSON cannot serialize Infinity; coerce to a large finite sentinel.
      const zScore = Number.isFinite(result.zScore) ? result.zScore : 9999;
      res.json({ ...result, zScore });
    } catch(error) { respondHistoryError(error,res); }
  });

  // GET /api/baselines — per-domain 42-day duration baseline (mean, stdDev,
  // sample count, cold-start flag) for the authenticated user. Surfaces what
  // "normal" looks like before an anomaly prompt fires, so users can build
  // trust in the detector and notice baseline drift over time.
  app.get("/api/baselines", isAuthenticated, async (req: any, res) => {
    try {
      const userId: string = req.user.claims.sub;
      const now = new Date();
      const sessions = await historyReads.baseline(userId, now);
      const perDomain: Record<string, ReturnType<typeof computeBaseline>> = {};
      for (const d of domainEnum) {
        perDomain[d] = computeBaseline(d, sessions, { now });
      }
      res.json({
        baselineDays: BASELINE_DAYS,
        coldStartThreshold: COLD_START_THRESHOLD,
        perDomain,
      });
    } catch(error) { respondHistoryError(error,res); }
  });

  // GET /api/sessions/deleted — soft-deleted sessions for the authenticated user.
  // Static path is registered before /api/sessions/:id below so it is not
  // captured as an :id parameter.
  app.get("/api/sessions/deleted",isAuthenticated,async(req:any,res)=>{
    res.setHeader("Cache-Control","no-store");
    try{res.json(await historyReads.page(req.user.claims.sub,"deleted",parseHistoryPage(req.query)));}
    catch(error){respondHistoryError(error,res);}
  });
  app.get("/api/sessions/:id/text",isAuthenticated,async(req:any,res)=>{
    res.setHeader("Cache-Control","no-store");
    try{res.json(await historyReads.text(req.user.claims.sub,"sessions",req.params.id,req.query));}
    catch(error){respondHistoryError(error,res);}
  });
  app.get("/api/sessions/:id",isAuthenticated,async(req:any,res)=>{
    res.setHeader("Cache-Control","no-store");
    try{if(Object.keys(req.query).length)throw new HistoryInputError();
      res.json(await historyReads.detail(req.user.claims.sub,"sessions",req.params.id));}
    catch(error){respondHistoryError(error,res);}
  });

  // PATCH /api/sessions/:id — edit a non-deleted session. Body must include
  // `reason` so every change is captured in the edit-history audit table.
  // Reject explicit blank explanations here. Omission is checked against
  // the owned locked row so unchanged historical text need not be resubmitted.
  app.patch("/api/sessions/:id", isAuthenticated, async (req: any, res) => {
    const parsed = updateSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid session patch", errors: parsed.error.flatten() });
    }
    if (parsed.data.isAnomaly && parsed.data.anomalyNote !== undefined && !parsed.data.anomalyNote?.trim()) {
      return res.status(400).json({ message: "Anomaly note is required when isAnomaly is true" });
    }
    try {
      const userId: string = req.user.claims.sub;
      const synchronized = await sessionMutations.edit(req, req.params.id, parsed.data);
      if (synchronized !== undefined) return res.json(synchronized);
      const row = await storage.updateSession(userId, req.params.id, parsed.data);
      if (!row) return res.status(404).json({ message: "Session not found" });
      res.json(serializeSession(row));
    } catch (error) {
      if (respondWriteError(error,res)) return;
      if (error instanceof ResourceLimitError) return respondHistoryError(error,res);
      if (sessionMutations.respondError(error, res, "edit")) return;
      res.status(500).json({ message: "Failed to update session" });
    }
  });

  // DELETE /api/sessions/:id — soft-delete (sets deletedAt; never hard-deletes).
  app.delete("/api/sessions/:id", isAuthenticated, async (req: any, res) => {
    try {
      const userId: string = req.user.claims.sub;
      const synchronized = await sessionMutations.softDelete(req, req.params.id);
      if (synchronized !== undefined) return res.json(synchronized);
      const row = await storage.softDeleteSession(userId, req.params.id);
      if (!row) return res.status(404).json({ message: "Session not found" });
      res.json(serializeSession(row));
    } catch (error) {
      if (respondWriteError(error,res)) return;
      if (error instanceof ResourceLimitError) return respondHistoryError(error,res);
      if (sessionMutations.respondError(error, res, "softDelete")) return;
      res.status(500).json({ message: "Failed to delete session" });
    }
  });

  // POST /api/sessions/:id/restore — clear deletedAt on a soft-deleted session.
  app.post("/api/sessions/:id/restore", isAuthenticated, async (req: any, res) => {
    try {
      const userId: string = req.user.claims.sub;
      const synchronized = await sessionMutations.restore(req, req.params.id);
      if (synchronized !== undefined) return res.json(synchronized);
      const row = await storage.restoreSession(userId, req.params.id);
      if (!row) return res.status(404).json({ message: "Deleted session not found" });
      res.json(serializeSession(row));
    } catch (error) {
      if (respondWriteError(error,res)) return;
      if (error instanceof ResourceLimitError) return respondHistoryError(error,res);
      if (sessionMutations.respondError(error, res, "restore")) return;
      res.status(500).json({ message: "Failed to restore session" });
    }
  });

  // ----- Deviations CRUD -----

  // GET /api/deviations — list all (active + planned + ended) non-deleted deviations.
  // Optional ?state=active|planned filter.
  app.get("/api/deviations",isAuthenticated,async(req:any,res)=>{
    res.setHeader("Cache-Control","no-store");
    try{res.json(await historyReads.page(req.user.claims.sub,"deviations",parseHistoryPage(req.query,true)));}
    catch(error){respondHistoryError(error,res);}
  });
  app.get("/api/deviations/:id/text",isAuthenticated,async(req:any,res)=>{
    res.setHeader("Cache-Control","no-store");
    try{res.json(await historyReads.text(req.user.claims.sub,"deviations",req.params.id,req.query));}
    catch(error){respondHistoryError(error,res);}
  });
  app.get("/api/deviations/:id",isAuthenticated,async(req:any,res)=>{
    res.setHeader("Cache-Control","no-store");
    try{if(Object.keys(req.query).length)throw new HistoryInputError();
      res.json(await historyReads.detail(req.user.claims.sub,"deviations",req.params.id));}
    catch(error){respondHistoryError(error,res);}
  });

  // POST /api/deviations — create
  app.post("/api/deviations", isAuthenticated, async (req: any, res) => {
    const parsed = insertDeviationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid deviation data", errors: parsed.error.flatten() });
    }
    try {
      const row = await deviationMutations.create(req, parsed.data);
      res.status(201).json(serializeDeviation(row));
    } catch (error) {
      if (respondWriteError(error,res)) return;
      if (error instanceof BoundaryError) return res.status(error.status).json({ message: error.message });
      if (error instanceof ResourceLimitError) return respondHistoryError(error,res);
      res.status(500).json({ message: "Failed to create deviation" });
    }
  });

  // PATCH /api/deviations/:id — update reason/start/end/excludeFromComposite
  app.patch("/api/deviations/:id", isAuthenticated, async (req: any, res) => {
    const parsed = updateDeviationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid deviation patch", errors: parsed.error.flatten() });
    }
    try {
      const row = await deviationMutations.edit(req, req.params.id, parsed.data);
      if (!row) return res.status(404).json({ message: "Deviation not found" });
      res.json(serializeDeviation(row));
    } catch (error) {
      if (respondWriteError(error,res)) return;
      if (error instanceof BoundaryError) return res.status(error.status).json({ message: error.message });
      if (error instanceof ResourceLimitError) return respondHistoryError(error,res);
      res.status(500).json({ message: "Failed to update deviation" });
    }
  });

  // POST /api/deviations/:id/end — mark active deviation ended now
  app.post("/api/deviations/:id/end", isAuthenticated, async (req: any, res) => {
    const parsed = deviationLifecycleSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: "Invalid change reason", errors: parsed.error.flatten() });
    try {
      const row = await deviationMutations.end(req, req.params.id, parsed.data);
      if (!row) return res.status(404).json({ message: "Deviation not found or already ended" });
      res.json(serializeDeviation(row));
    } catch (error) {
      if (respondWriteError(error,res)) return;
      if (error instanceof BoundaryError) return res.status(error.status).json({ message: error.message });
      if (error instanceof ResourceLimitError) return respondHistoryError(error,res);
      res.status(500).json({ message: "Failed to end deviation" });
    }
  });

  // DELETE /api/deviations/:id — soft delete
  app.delete("/api/deviations/:id", isAuthenticated, async (req: any, res) => {
    const parsed = deviationLifecycleSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: "Invalid change reason", errors: parsed.error.flatten() });
    try {
      const row = await deviationMutations.softDelete(req, req.params.id, parsed.data);
      if (!row) return res.status(404).json({ message: "Deviation not found" });
      res.json(serializeDeviation(row));
    } catch (error) {
      if (respondWriteError(error,res)) return;
      if (error instanceof BoundaryError) return res.status(error.status).json({ message: error.message });
      if (error instanceof ResourceLimitError) return respondHistoryError(error,res);
      res.status(500).json({ message: "Failed to delete deviation" });
    }
  });

  return httpServer;
}

function serializeSession(row: import("@shared/schema").Session) {
  return {
    ...row,
    timestamp: row.timestamp.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

function serializeDeviation(row: import("@shared/schema").Deviation) {
  return {
    ...row,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt ? row.endAt.toISOString() : null,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

function respondHistoryError(error:unknown,res:{status:(n:number)=>any}){
  if(error instanceof ResourceLimitError)return res.status(503).json({message:error.message,code:error.code});
  if(error instanceof HistoryInputError)return res.status(400).json({message:"Invalid history request"});
  if(error instanceof HistoryNotFound)return res.status(404).json({message:"Record not found"});
  if(error instanceof HistoryChanged)return res.status(409).json({message:"Record changed. Reload its details before reading more text.",code:"HISTORY_CHANGED"});
  return res.status(503).json({message:"History is unavailable. Your records have not been changed."});
}

function respondWriteError(error:unknown,res:{status:(n:number)=>any;setHeader:(name:string,value:string)=>unknown}):boolean{
  if(error instanceof WriteResourceLimitError){
    if(error.retryAfterSeconds!==null)res.setHeader("Retry-After",String(error.retryAfterSeconds));
    res.status(429).json({message:error.message,code:error.code,retryAfterSeconds:error.retryAfterSeconds});return true;
  }
  if(error instanceof BoundaryError&&error.status===400){res.status(400).json({message:error.message});return true;}
  return false;
}
