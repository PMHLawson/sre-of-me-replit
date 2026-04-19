import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import {
  insertSessionSchema,
  updateSessionSchema,
  insertDeviationSchema,
  updateDeviationSchema,
  anomalyCheckRequestSchema,
} from "@shared/schema";
import { isAuthenticated } from "./replit_integrations/auth";
import { authStorage } from "./replit_integrations/auth/storage";
import { computeCompositeState, isInRampUp } from "./lib/policy-engine";
import { computeEscalationState } from "./lib/escalation";
import { detectAnomaly, BASELINE_DAYS } from "./lib/anomaly";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // GET /api/sessions — return sessions for the authenticated user (most recent first)
  app.get("/api/sessions", isAuthenticated, async (req: any, res) => {
    try {
      const userId: string = req.user.claims.sub;
      const sessions = await storage.getSessions(userId);
      res.json(sessions.map(serializeSession));
    } catch {
      res.status(500).json({ message: "Failed to fetch sessions" });
    }
  });

  // GET /api/policy-state — return per-service + composite policy state for the authenticated user
  // Source of truth for Dashboard, Decide, Domain Detail, History, and System Health.
  app.get("/api/policy-state", isAuthenticated, async (req: any, res) => {
    try {
      const userId: string = req.user.claims.sub;
      const [sessions, activeDeviations, user] = await Promise.all([
        storage.getSessions(userId),
        storage.getActiveDeviations(userId),
        authStorage.getUser(userId),
      ]);
      const userCreatedAt = user?.createdAt ?? undefined;
      const state = computeCompositeState(sessions, { deviations: activeDeviations, userCreatedAt });
      // B3.1 — Surface ramp-up flag on policy-state too so Dashboard surfaces
      // can branch without making a second API call to /api/escalation-state.
      res.json({ ...state, isRampUp: isInRampUp(userCreatedAt) });
    } catch {
      res.status(500).json({ message: "Failed to compute policy state" });
    }
  });

  // GET /api/escalation-state — per-domain escalation tier, error-budget, burn-rate, recommended action.
  // Derived from the same session stream that feeds /api/policy-state.
  app.get("/api/escalation-state", isAuthenticated, async (req: any, res) => {
    try {
      const userId: string = req.user.claims.sub;
      const [sessions, activeDeviations, user] = await Promise.all([
        storage.getSessions(userId),
        storage.getActiveDeviations(userId),
        authStorage.getUser(userId),
      ]);
      const state = computeEscalationState(sessions, {
        deviations: activeDeviations,
        userCreatedAt: user?.createdAt ?? undefined,
      });
      res.json(state);
    } catch {
      res.status(500).json({ message: "Failed to compute escalation state" });
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
      const session = await storage.createSession({
        ...parsed.data,
        userId,
        isAnomaly: parsed.data.isAnomaly ?? false,
        anomalyNote: parsed.data.isAnomaly ? (parsed.data.anomalyNote ?? null) : null,
      });
      res.status(201).json(serializeSession(session));
    } catch {
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
      const cutoff = new Date(Date.now() - BASELINE_DAYS * 24 * 60 * 60 * 1000);
      const sessions = await storage.getSessionsSince(userId, cutoff);
      const result = detectAnomaly(parsed.data.domain, parsed.data.durationMinutes, sessions);
      // JSON cannot serialize Infinity; coerce to a large finite sentinel.
      const zScore = Number.isFinite(result.zScore) ? result.zScore : 9999;
      res.json({ ...result, zScore });
    } catch {
      res.status(500).json({ message: "Failed to compute anomaly check" });
    }
  });

  // GET /api/sessions/deleted — soft-deleted sessions for the authenticated user.
  // Static path is registered before /api/sessions/:id below so it is not
  // captured as an :id parameter.
  app.get("/api/sessions/deleted", isAuthenticated, async (req: any, res) => {
    try {
      const userId: string = req.user.claims.sub;
      const rows = await storage.getDeletedSessions(userId);
      res.json(rows.map(serializeSession));
    } catch {
      res.status(500).json({ message: "Failed to fetch deleted sessions" });
    }
  });

  // PATCH /api/sessions/:id — edit a non-deleted session. Body must include
  // `reason` so every change is captured in the edit-history audit table.
  app.patch("/api/sessions/:id", isAuthenticated, async (req: any, res) => {
    const parsed = updateSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid session patch", errors: parsed.error.flatten() });
    }
    try {
      const userId: string = req.user.claims.sub;
      const row = await storage.updateSession(userId, req.params.id, parsed.data);
      if (!row) return res.status(404).json({ message: "Session not found" });
      res.json(serializeSession(row));
    } catch {
      res.status(500).json({ message: "Failed to update session" });
    }
  });

  // DELETE /api/sessions/:id — soft-delete (sets deletedAt; never hard-deletes).
  app.delete("/api/sessions/:id", isAuthenticated, async (req: any, res) => {
    try {
      const userId: string = req.user.claims.sub;
      const row = await storage.softDeleteSession(userId, req.params.id);
      if (!row) return res.status(404).json({ message: "Session not found" });
      res.json(serializeSession(row));
    } catch {
      res.status(500).json({ message: "Failed to delete session" });
    }
  });

  // POST /api/sessions/:id/restore — clear deletedAt on a soft-deleted session.
  app.post("/api/sessions/:id/restore", isAuthenticated, async (req: any, res) => {
    try {
      const userId: string = req.user.claims.sub;
      const row = await storage.restoreSession(userId, req.params.id);
      if (!row) return res.status(404).json({ message: "Deleted session not found" });
      res.json(serializeSession(row));
    } catch {
      res.status(500).json({ message: "Failed to restore session" });
    }
  });

  // ----- Deviations CRUD -----

  // GET /api/deviations — list all (active + planned + ended) non-deleted deviations.
  // Optional ?state=active|planned filter.
  app.get("/api/deviations", isAuthenticated, async (req: any, res) => {
    try {
      const userId: string = req.user.claims.sub;
      const state = typeof req.query.state === "string" ? req.query.state : undefined;
      let rows;
      if (state === "active") {
        rows = await storage.getActiveDeviations(userId);
      } else if (state === "planned") {
        rows = await storage.getPlannedDeviations(userId);
      } else {
        rows = await storage.getAllDeviations(userId);
      }
      res.json(rows.map(serializeDeviation));
    } catch {
      res.status(500).json({ message: "Failed to fetch deviations" });
    }
  });

  // GET /api/deviations/:id
  app.get("/api/deviations/:id", isAuthenticated, async (req: any, res) => {
    try {
      const userId: string = req.user.claims.sub;
      const row = await storage.getDeviation(userId, req.params.id);
      if (!row) return res.status(404).json({ message: "Deviation not found" });
      res.json(serializeDeviation(row));
    } catch {
      res.status(500).json({ message: "Failed to fetch deviation" });
    }
  });

  // POST /api/deviations — create
  app.post("/api/deviations", isAuthenticated, async (req: any, res) => {
    const parsed = insertDeviationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid deviation data", errors: parsed.error.flatten() });
    }
    try {
      const userId: string = req.user.claims.sub;
      const row = await storage.createDeviation({ ...parsed.data, userId });
      res.status(201).json(serializeDeviation(row));
    } catch {
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
      const userId: string = req.user.claims.sub;
      const row = await storage.updateDeviation(userId, req.params.id, parsed.data);
      if (!row) return res.status(404).json({ message: "Deviation not found" });
      res.json(serializeDeviation(row));
    } catch {
      res.status(500).json({ message: "Failed to update deviation" });
    }
  });

  // POST /api/deviations/:id/end — mark active deviation ended now
  app.post("/api/deviations/:id/end", isAuthenticated, async (req: any, res) => {
    try {
      const userId: string = req.user.claims.sub;
      const row = await storage.endDeviation(userId, req.params.id);
      if (!row) return res.status(404).json({ message: "Deviation not found or already ended" });
      res.json(serializeDeviation(row));
    } catch {
      res.status(500).json({ message: "Failed to end deviation" });
    }
  });

  // DELETE /api/deviations/:id — soft delete
  app.delete("/api/deviations/:id", isAuthenticated, async (req: any, res) => {
    try {
      const userId: string = req.user.claims.sub;
      const row = await storage.softDeleteDeviation(userId, req.params.id);
      if (!row) return res.status(404).json({ message: "Deviation not found" });
      res.json(serializeDeviation(row));
    } catch {
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
