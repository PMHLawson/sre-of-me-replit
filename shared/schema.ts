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

// ----- Policy state response (GET /api/policy-state) -----

export const complianceColorEnum = ["green", "yellow", "red"] as const;
export type ComplianceColor = typeof complianceColorEnum[number];

export const domainPolicySpecSchema = z.object({
  targetMinutes: z.number(),
  sessionFloor: z.number(),
  sessionsTarget: z.number(),
  cadence: z.string(),
  dailyProRate: z.number(),
});

export const serviceStateSchema = z.object({
  domain: z.enum(domainEnum),
  logical_day: z.string(),
  actual_qualifying_days: z.number(),
  actual_minutes: z.number(),
  session_score: z.number(),
  duration_score: z.number(),
  service_score: z.number(),
  service_weight: z.number(),
  compliance_color: z.enum(complianceColorEnum),
  policy: domainPolicySpecSchema,
  window_days: z.array(z.string()),
});

export const policyStateResponseSchema = z.object({
  logical_day: z.string(),
  window_days: z.array(z.string()),
  services: z.record(z.enum(domainEnum), serviceStateSchema),
  composite_score: z.number(),
  composite_color: z.enum(complianceColorEnum),
});

export type ServiceState = z.infer<typeof serviceStateSchema>;
export type PolicyStateResponse = z.infer<typeof policyStateResponseSchema>;

// ----- Escalation state response (GET /api/escalation-state) -----

export const escalationTierEnum = ["NOMINAL", "ADVISORY", "WARNING", "BREACH", "PAGE"] as const;
export type EscalationTier = typeof escalationTierEnum[number];

export const errorBudgetSchema = z.object({
  consumedMinutes: z.number(),
  allowedMinutes: z.number(),
  remainingMinutes: z.number(),
  percentRemaining: z.number(),
});

export const domainEscalationSchema = z.object({
  domain: z.enum(domainEnum),
  tier: z.enum(escalationTierEnum),
  rationale: z.string(),
  recommendedAction: z.string(),
  consecutiveLowDays: z.number(),
  burnRate: z.number(),
  errorBudget: errorBudgetSchema,
});

export const escalationStateResponseSchema = z.object({
  logical_day: z.string(),
  perDomain: z.record(z.enum(domainEnum), domainEscalationSchema),
  highestTier: z.enum(escalationTierEnum),
});

export type ErrorBudget = z.infer<typeof errorBudgetSchema>;
export type DomainEscalation = z.infer<typeof domainEscalationSchema>;
export type EscalationStateResponse = z.infer<typeof escalationStateResponseSchema>;
