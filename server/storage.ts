import { db } from "./db";
import { sessions, type Session, type InsertSession } from "@shared/schema";
import { eq, desc, gte, and } from "drizzle-orm";

export interface IStorage {
  getSessions(userId: string): Promise<Session[]>;
  getSessionsSince(userId: string, since: Date): Promise<Session[]>;
  createSession(session: InsertSession & { userId: string }): Promise<Session>;
}

export class DatabaseStorage implements IStorage {
  async getSessions(userId: string): Promise<Session[]> {
    return db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(desc(sessions.timestamp));
  }

  async getSessionsSince(userId: string, since: Date): Promise<Session[]> {
    return db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), gte(sessions.timestamp, since)))
      .orderBy(desc(sessions.timestamp));
  }

  async createSession(insertSession: InsertSession & { userId: string }): Promise<Session> {
    const [session] = await db
      .insert(sessions)
      .values({ ...insertSession, timestamp: new Date(insertSession.timestamp) })
      .returning();
    return session;
  }
}

export const storage = new DatabaseStorage();
