import { db } from "./db";
import { sessions, users, type Session, type InsertSession, type User, type InsertUser } from "@shared/schema";
import { eq, desc, gte, and } from "drizzle-orm";

export interface IStorage {
  getSessions(): Promise<Session[]>;
  getSessionsSince(since: Date): Promise<Session[]>;
  createSession(session: InsertSession): Promise<Session>;
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
}

export class DatabaseStorage implements IStorage {
  async getSessions(): Promise<Session[]> {
    return db.select().from(sessions).orderBy(desc(sessions.timestamp));
  }

  async getSessionsSince(since: Date): Promise<Session[]> {
    return db
      .select()
      .from(sessions)
      .where(gte(sessions.timestamp, since))
      .orderBy(desc(sessions.timestamp));
  }

  async createSession(insertSession: InsertSession): Promise<Session> {
    const [session] = await db
      .insert(sessions)
      .values({ ...insertSession, timestamp: new Date(insertSession.timestamp) })
      .returning();
    return session;
  }

  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }
}

export const storage = new DatabaseStorage();
