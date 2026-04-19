import { db } from "./db";
import {
  sessions,
  sessionEdits,
  deviations,
  type Session,
  type InsertSession,
  type UpdateSession,
  type Deviation,
  type InsertDeviation,
  type UpdateDeviation,
} from "@shared/schema";
import { eq, desc, gte, and, isNull, lte, lt, or, asc, gt, isNotNull } from "drizzle-orm";

export interface IStorage {
  getSessions(userId: string): Promise<Session[]>;
  getSessionsSince(userId: string, since: Date): Promise<Session[]>;
  createSession(session: InsertSession & { userId: string }): Promise<Session>;
  updateSession(userId: string, id: string, patch: UpdateSession): Promise<Session | undefined>;
  softDeleteSession(userId: string, id: string): Promise<Session | undefined>;
  restoreSession(userId: string, id: string): Promise<Session | undefined>;
  getDeletedSessions(userId: string): Promise<Session[]>;
  /**
   * Hard-delete soft-deleted sessions strictly older than `olderThan`
   * (`deletedAt < olderThan`). Active sessions (`deletedAt IS NULL`) are
   * never matched. Idempotent — once expired rows are removed a re-run with
   * the same cutoff is a no-op. Returns the number of rows removed.
   */
  purgeExpiredDeletedSessions(olderThan: Date): Promise<number>;

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
      .where(and(eq(sessions.userId, userId), isNull(sessions.deletedAt)))
      .orderBy(desc(sessions.timestamp));
  }

  async getSessionsSince(userId: string, since: Date): Promise<Session[]> {
    return db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.deletedAt),
          gte(sessions.timestamp, since),
        ),
      )
      .orderBy(desc(sessions.timestamp));
  }

  async createSession(insertSession: InsertSession & { userId: string }): Promise<Session> {
    const [session] = await db
      .insert(sessions)
      .values({ ...insertSession, timestamp: new Date(insertSession.timestamp) })
      .returning();
    return session;
  }

  /**
   * Apply a PATCH to a non-deleted session and write a single edit-history
   * row capturing the prior values of the changed fields plus the reason.
   * Returns the updated session, or undefined if no matching active row exists.
   * The history row and the update happen in one transaction so an audit row
   * is never written without the matching update (and vice versa).
   */
  async updateSession(
    userId: string,
    id: string,
    patch: UpdateSession,
  ): Promise<Session | undefined> {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, userId),
            eq(sessions.id, id),
            isNull(sessions.deletedAt),
          ),
        );
      if (!current) return undefined;

      const update: Partial<typeof sessions.$inferInsert> = {};
      const prior: Record<string, unknown> = {};
      if (patch.domain !== undefined && patch.domain !== current.domain) {
        update.domain = patch.domain;
        prior.domain = current.domain;
      }
      if (patch.durationMinutes !== undefined && patch.durationMinutes !== current.durationMinutes) {
        update.durationMinutes = patch.durationMinutes;
        prior.durationMinutes = current.durationMinutes;
      }
      if (patch.timestamp !== undefined) {
        const next = new Date(patch.timestamp);
        if (next.getTime() !== current.timestamp.getTime()) {
          update.timestamp = next;
          prior.timestamp = current.timestamp.toISOString();
        }
      }
      if (patch.notes !== undefined && (patch.notes ?? null) !== (current.notes ?? null)) {
        update.notes = patch.notes ?? null;
        prior.notes = current.notes;
      }

      // No-op edits still record an audit row so the reason note is preserved.
      await tx.insert(sessionEdits).values({
        sessionId: id,
        userId,
        reason: patch.reason,
        changedFields: JSON.stringify(prior),
      });

      if (Object.keys(update).length === 0) {
        return current;
      }

      const [updated] = await tx
        .update(sessions)
        .set(update)
        .where(
          and(
            eq(sessions.userId, userId),
            eq(sessions.id, id),
            isNull(sessions.deletedAt),
          ),
        )
        .returning();
      return updated;
    });
  }

  async softDeleteSession(userId: string, id: string): Promise<Session | undefined> {
    const [row] = await db
      .update(sessions)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.id, id),
          isNull(sessions.deletedAt),
        ),
      )
      .returning();
    return row;
  }

  async restoreSession(userId: string, id: string): Promise<Session | undefined> {
    const [row] = await db
      .update(sessions)
      .set({ deletedAt: null })
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.id, id),
          isNotNull(sessions.deletedAt),
        ),
      )
      .returning();
    return row;
  }

  async getDeletedSessions(userId: string): Promise<Session[]> {
    return db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNotNull(sessions.deletedAt)))
      .orderBy(desc(sessions.deletedAt));
  }

  async purgeExpiredDeletedSessions(olderThan: Date): Promise<number> {
    // Strict comparator (deletedAt < olderThan) — matches the "older than"
    // semantics of the IStorage contract. Predicate is gated to soft-deleted
    // rows only, so active sessions (deletedAt IS NULL) are never matched
    // and a re-run with the same cutoff is a no-op (idempotent).
    const removed = await db
      .delete(sessions)
      .where(and(isNotNull(sessions.deletedAt), lt(sessions.deletedAt, olderThan)))
      .returning({ id: sessions.id });
    return removed.length;
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
