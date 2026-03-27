import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Auth models: users table + http session store (owned by Replit Auth)
export * from "./models/auth";

export const domainEnum = ['martial-arts', 'meditation', 'fitness', 'music'] as const;
export type Domain = typeof domainEnum[number];

// Cultivation sessions — user-owned.
// userId is nullable to preserve existing data; required for all new sessions.
// Architecture note: org/team context column can be added here when needed.
export const sessions = pgTable("sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: text("user_id"),
  domain: text("domain").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  notes: text("notes"),
});

export const insertSessionSchema = createInsertSchema(sessions).omit({ id: true }).extend({
  domain: z.enum(domainEnum),
  durationMinutes: z.number().int().positive(),
  timestamp: z.string().datetime({ offset: true }),
  notes: z.string().optional(),
});

export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessions.$inferSelect;
