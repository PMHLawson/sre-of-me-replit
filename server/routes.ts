import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertSessionSchema } from "@shared/schema";
import { isAuthenticated } from "./replit_integrations/auth";

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
