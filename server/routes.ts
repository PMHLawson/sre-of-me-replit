import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertSessionSchema } from "@shared/schema";
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
      const sessions = await storage.getSessions(userId);
      const state = computeCompositeState(sessions);
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
      const sessions = await storage.getSessions(userId);
      const state = computeEscalationState(sessions);
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

  return httpServer;
}
