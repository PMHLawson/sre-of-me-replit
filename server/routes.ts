import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertSessionSchema, insertDeviationSchema, updateDeviationSchema } from "@shared/schema";
import { isAuthenticated } from "./replit_integrations/auth";
import { computeCompositeState } from "./lib/policy-engine";
import { computeEscalationState } from "./lib/escalation";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // GET /api/sessions — return sessions for the authenticated user (most recent first)
  app.get("/api/sessions", isAuthenticated, async (req: any, res) => {
    try {
      const userId: string = req.user.claims.sub;
      const sessions = await storage.getSessions(userId);
      res.json(sessions.map(s => ({ ...s, timestamp: s.timestamp.toISOString() })));
    } catch {
      res.status(500).json({ message: "Failed to fetch sessions" });
    }
  });

  // GET /api/policy-state — return per-service + composite policy state for the authenticated user
  // Source of truth for Dashboard, Decide, Domain Detail, History, and System Health.
  app.get("/api/policy-state", isAuthenticated, async (req: any, res) => {
    try {
      const userId: string = req.user.claims.sub;
      const [sessions, activeDeviations] = await Promise.all([
        storage.getSessions(userId),
        storage.getActiveDeviations(userId),
      ]);
      const state = computeCompositeState(sessions, { deviations: activeDeviations });
      res.json(state);
    } catch {
      res.status(500).json({ message: "Failed to compute policy state" });
    }
  });

  // GET /api/escalation-state — per-domain escalation tier, error-budget, burn-rate, recommended action.
  // Derived from the same session stream that feeds /api/policy-state.
  app.get("/api/escalation-state", isAuthenticated, async (req: any, res) => {
    try {
      const userId: string = req.user.claims.sub;
      const [sessions, activeDeviations] = await Promise.all([
        storage.getSessions(userId),
        storage.getActiveDeviations(userId),
      ]);
      const state = computeEscalationState(sessions, { deviations: activeDeviations });
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
    try {
      const userId: string = req.user.claims.sub;
      const session = await storage.createSession({ ...parsed.data, userId });
      res.status(201).json({ ...session, timestamp: session.timestamp.toISOString() });
    } catch {
      res.status(500).json({ message: "Failed to create session" });
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

function serializeDeviation(row: import("@shared/schema").Deviation) {
  return {
    ...row,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt ? row.endAt.toISOString() : null,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}
