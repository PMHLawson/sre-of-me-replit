import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertSessionSchema } from "@shared/schema";
import { z } from "zod";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // GET /api/sessions — return all sessions (most recent first)
  app.get("/api/sessions", async (_req, res) => {
    try {
      const sessions = await storage.getSessions();
      // Serialize timestamps as ISO strings for client consistency
      res.json(sessions.map(s => ({ ...s, timestamp: s.timestamp.toISOString() })));
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch sessions" });
    }
  });

  // POST /api/sessions — log a new session
  app.post("/api/sessions", async (req, res) => {
    const parsed = insertSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid session data", errors: parsed.error.flatten() });
    }
    try {
      const session = await storage.createSession(parsed.data);
      res.status(201).json({ ...session, timestamp: session.timestamp.toISOString() });
    } catch (err) {
      res.status(500).json({ message: "Failed to create session" });
    }
  });

  return httpServer;
}
