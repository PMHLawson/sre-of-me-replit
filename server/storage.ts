import { db } from "./db";
import {
  sessions,
  deviations,
  type Session,
  type InsertSession,
  type Deviation,
  type InsertDeviation,
  type UpdateDeviation,
} from "@shared/schema";
import { eq, desc, gte, and, isNull, lte, or, asc, gt } from "drizzle-orm";

export interface IStorage {
  getSessions(userId: string): Promise<Session[]>;
  getSessionsSince(userId: string, since: Date): Promise<Session[]>;
  createSession(session: InsertSession & { userId: string }): Promise<Session>;

  // Deviations
  createDeviation(deviation: InsertDeviation & { userId: string }): Promise<Deviation>;
  getActiveDeviations(userId: string, now?: Date): Promise<Deviation[]>;
  getPlannedDeviations(userId: string, now?: Date): Promise<Deviation[]>;
  getAllDeviations(userId: string): Promise<Deviation[]>;
  getDeviation(userId: string, id: string): Promise<Deviation | undefined>;
  updateDeviation(userId: string, id: string, patch: UpdateDeviation): Promise<Deviation | undefined>;
  endDeviation(userId: string, id: string, endedAt?: Date): Promise<Deviation | undefined>;
  softDeleteDeviation(userId: string, id: string): Promise<Deviation | undefined>;
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

  // ----- Deviations -----

  async createDeviation(input: InsertDeviation & { userId: string }): Promise<Deviation> {
    const [row] = await db
      .insert(deviations)
      .values({
        userId: input.userId,
        domain: input.domain,
        reason: input.reason,
        startAt: new Date(input.startAt),
        endAt: input.endAt ? new Date(input.endAt) : null,
        excludeFromComposite: input.excludeFromComposite ?? true,
      })
      .returning();
    return row;
  }

  async getActiveDeviations(userId: string, now: Date = new Date()): Promise<Deviation[]> {
    return db
      .select()
      .from(deviations)
      .where(
        and(
          eq(deviations.userId, userId),
          isNull(deviations.deletedAt),
          isNull(deviations.endedAt),
          lte(deviations.startAt, now),
          or(isNull(deviations.endAt), gte(deviations.endAt, now)),
        ),
      )
      .orderBy(asc(deviations.startAt));
  }

  async getPlannedDeviations(userId: string, now: Date = new Date()): Promise<Deviation[]> {
    return db
      .select()
      .from(deviations)
      .where(
        and(
          eq(deviations.userId, userId),
          isNull(deviations.deletedAt),
          isNull(deviations.endedAt),
          gt(deviations.startAt, now),
        ),
      )
      .orderBy(asc(deviations.startAt));
  }

  async getAllDeviations(userId: string): Promise<Deviation[]> {
    return db
      .select()
      .from(deviations)
      .where(and(eq(deviations.userId, userId), isNull(deviations.deletedAt)))
      .orderBy(desc(deviations.startAt));
  }

  async getDeviation(userId: string, id: string): Promise<Deviation | undefined> {
    const [row] = await db
      .select()
      .from(deviations)
      .where(
        and(
          eq(deviations.userId, userId),
          eq(deviations.id, id),
          isNull(deviations.deletedAt),
        ),
      );
    return row;
  }

  async updateDeviation(
    userId: string,
    id: string,
    patch: UpdateDeviation,
  ): Promise<Deviation | undefined> {
    const update: Partial<typeof deviations.$inferInsert> = {};
    if (patch.reason !== undefined) update.reason = patch.reason;
    if (patch.startAt !== undefined) update.startAt = new Date(patch.startAt);
    if (patch.endAt !== undefined) update.endAt = patch.endAt ? new Date(patch.endAt) : null;
    if (patch.excludeFromComposite !== undefined) update.excludeFromComposite = patch.excludeFromComposite;
    if (Object.keys(update).length === 0) {
      return this.getDeviation(userId, id);
    }
    const [row] = await db
      .update(deviations)
      .set(update)
      .where(
        and(
          eq(deviations.userId, userId),
          eq(deviations.id, id),
          isNull(deviations.deletedAt),
        ),
      )
      .returning();
    return row;
  }

  async endDeviation(userId: string, id: string, endedAt: Date = new Date()): Promise<Deviation | undefined> {
    const [row] = await db
      .update(deviations)
      .set({ endedAt })
      .where(
        and(
          eq(deviations.userId, userId),
          eq(deviations.id, id),
          isNull(deviations.deletedAt),
          isNull(deviations.endedAt),
        ),
      )
      .returning();
    return row;
  }

  async softDeleteDeviation(userId: string, id: string): Promise<Deviation | undefined> {
    const [row] = await db
      .update(deviations)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(deviations.userId, userId),
          eq(deviations.id, id),
          isNull(deviations.deletedAt),
        ),
      )
      .returning();
    return row;
  }
}

export const storage = new DatabaseStorage();
