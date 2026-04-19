import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, boolean } from "drizzle-orm/pg-core";
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
  // Soft-delete marker. Active sessions have NULL. Set on DELETE; cleared on RESTORE.
  // Hard-deletion is performed by the retention purge (B2.4).
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  // C1.1 — Anomaly flag set when the user confirmed a 2-sigma duration anomaly
  // at save time. Stored on the row so historical surfaces can mark the session
  // without recomputing the baseline.
  isAnomaly: boolean("is_anomaly").notNull().default(false),
  // C1.1 — Required note when `isAnomaly` is true; null otherwise.
  anomalyNote: text("anomaly_note"),
});

export const insertSessionSchema = createInsertSchema(sessions)
  .omit({ id: true, deletedAt: true })
  .extend({
    domain: z.enum(domainEnum),
    durationMinutes: z.number().int().positive(),
    timestamp: z.string().datetime({ offset: true }),
    notes: z.string().optional(),
    // Backward-compatible: existing POST callers omit these and the row
    // defaults to isAnomaly=false / anomalyNote=null.
    isAnomaly: z.boolean().optional(),
    anomalyNote: z.string().nullable().optional(),
  });

/** POST /api/sessions/anomaly-check request payload. */
export const anomalyCheckRequestSchema = z.object({
  domain: z.enum(domainEnum),
  durationMinutes: z.number().int().positive(),
});

/** POST /api/sessions/anomaly-check response payload. */
export const anomalyCheckResponseSchema = z.object({
  isAnomaly: z.boolean(),
  coldStart: z.boolean(),
  sampleCount: z.number(),
  mean: z.number(),
  stdDev: z.number(),
  zScore: z.number(),
});

export type AnomalyCheckRequest = z.infer<typeof anomalyCheckRequestSchema>;
export type AnomalyCheckResponse = z.infer<typeof anomalyCheckResponseSchema>;

/**
 * PATCH /api/sessions/:id payload. All session fields are optional, but
 * `reason` (the edit-history note) is required so every change is audited.
 */
export const updateSessionSchema = z.object({
  domain: z.enum(domainEnum).optional(),
  durationMinutes: z.number().int().positive().optional(),
  timestamp: z.string().datetime({ offset: true }).optional(),
  notes: z.string().nullable().optional(),
  reason: z.string().min(1).max(500),
});

export type InsertSession = z.infer<typeof insertSessionSchema>;
export type UpdateSession = z.infer<typeof updateSessionSchema>;
export type Session = typeof sessions.$inferSelect;

/**
 * Per-edit audit log. Every PATCH on a session writes one row here capturing
 * the prior values of the changed fields plus the user-supplied reason.
 * `changedFields` is JSON text so the schema can grow without migrations.
 */
export const sessionEdits = pgTable("session_edits", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull(),
  userId: text("user_id").notNull(),
  editedAt: timestamp("edited_at", { withTimezone: true }).notNull().defaultNow(),
  reason: text("reason").notNull(),
  changedFields: text("changed_fields").notNull(),
});

export type SessionEdit = typeof sessionEdits.$inferSelect;

// ----- Policy state response (GET /api/policy-state) -----

export const complianceColorEnum = ["green", "yellow", "red"] as const;
export type ComplianceColor = typeof complianceColorEnum[number];

/**
 * C2.1 — Overachievement tier ladder. Mirrors the engine enum so the
 * client can render tier-specific visuals from the API response without a
 * second source of truth.
 */
export const overachievementTierEnum = ["NONE", "COMMITTED", "PEAK", "ELITE"] as const;
export type OverachievementTier = typeof overachievementTierEnum[number];

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
  /** True if an active deviation covers this domain at compute time. */
  is_deviated: z.boolean().optional(),
  /** True if the active deviation removes this domain from the composite weight. */
  excluded_from_composite: z.boolean().optional(),
  /** C2.1 — Uncapped MIN(raw_session_score, raw_duration_score). */
  overachievement_raw: z.number(),
  /** C2.1 — Tier derived from overachievement_raw. */
  overachievement_tier: z.enum(overachievementTierEnum),
});

export const policyStateResponseSchema = z.object({
  logical_day: z.string(),
  window_days: z.array(z.string()),
  services: z.record(z.enum(domainEnum), serviceStateSchema),
  composite_score: z.number(),
  composite_color: z.enum(complianceColorEnum),
  /** Domains excluded from the composite weighted average due to active deviation. */
  excluded_domains: z.array(z.enum(domainEnum)).optional(),
  /**
   * True when the requesting user is inside the post-signup ramp-up window
   * (B3.1). Surfaces use this to suppress escalation copy and apply the
   * teal/cyan "system calibrating" treatment.
   */
  isRampUp: z.boolean(),
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

export const escalationHistoryDayDomainSchema = z.object({
  tier: z.enum(escalationTierEnum),
  percentRemaining: z.number(),
});

export const escalationHistoryEntrySchema = z.object({
  logical_day: z.string(),
  perDomain: z.record(z.enum(domainEnum), escalationHistoryDayDomainSchema),
  highestTier: z.enum(escalationTierEnum),
});

/**
 * Display status used by the System Health banner. Collapses PAGE into BREACH
 * because both demand the same operator response in the UI surface.
 */
export const compositeDisplayStatusEnum = ["NOMINAL", "ADVISORY", "WARNING", "BREACH"] as const;
export type CompositeDisplayStatus = typeof compositeDisplayStatusEnum[number];

export const compositeEscalationSchema = z.object({
  /** Highest tier across all domains (mirrors `highestTier`). */
  tier: z.enum(escalationTierEnum),
  /** Banner-friendly status; PAGE collapses to BREACH. */
  displayStatus: z.enum(compositeDisplayStatusEnum),
  /** Pre-baked rationale string for the System Health banner. */
  rationale: z.string(),
  /** Pre-baked recommended next action for the System Health banner. */
  recommendedAction: z.string(),
  /** Domains grouped by tier — lets surfaces describe membership without recomputing. */
  domainsByTier: z.record(z.enum(escalationTierEnum), z.array(z.enum(domainEnum))),
});

export const escalationStateResponseSchema = z.object({
  logical_day: z.string(),
  perDomain: z.record(z.enum(domainEnum), domainEscalationSchema),
  highestTier: z.enum(escalationTierEnum),
  /**
   * Composite system-level summary derived from the same model as `perDomain`.
   * Surfaces (Dashboard banner, System Health banner) should consume this rather
   * than recomputing system status from individual domain scores client-side.
   */
  composite: compositeEscalationSchema,
  /** Per-day escalation tier history (oldest → newest), one entry per logical day. */
  history: z.array(escalationHistoryEntrySchema),
  /**
   * True when the requesting user is inside the post-signup ramp-up window
   * (B3.1). When true, all per-domain tiers and `highestTier` are forced to
   * NOMINAL; surfaces should display ramp-up copy instead of escalation copy.
   */
  isRampUp: z.boolean(),
});

export type ErrorBudget = z.infer<typeof errorBudgetSchema>;
export type DomainEscalation = z.infer<typeof domainEscalationSchema>;
export type EscalationHistoryDayDomain = z.infer<typeof escalationHistoryDayDomainSchema>;
export type EscalationHistoryEntry = z.infer<typeof escalationHistoryEntrySchema>;
export type CompositeEscalation = z.infer<typeof compositeEscalationSchema>;
export type EscalationStateResponse = z.infer<typeof escalationStateResponseSchema>;

// ----- Deviations -----
// A deviation marks a planned/active period where a domain is intentionally
// off-target (injury, travel, sabbatical, etc.). Active deviations may be
// excluded from the composite and hold the error budget steady.
// id is varchar+gen_random_uuid() and domain is text to match the existing
// `sessions` table convention in this project (Zod validates the domain enum
// at the API boundary). Changing to pgEnum/uuid() would diverge from the
// established schema pattern and trigger destructive migrations on existing tables.
export const deviations = pgTable("deviations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: text("user_id").notNull(),
  domain: text("domain").notNull(),
  reason: text("reason").notNull(),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  excludeFromComposite: boolean("exclude_from_composite").notNull().default(true),
});

export const insertDeviationSchema = createInsertSchema(deviations)
  .omit({ id: true, userId: true, endedAt: true, deletedAt: true })
  .extend({
    domain: z.enum(domainEnum),
    reason: z.string().min(1).max(500),
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }).nullable().optional(),
    excludeFromComposite: z.boolean().optional(),
  });

export const updateDeviationSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
  startAt: z.string().datetime({ offset: true }).optional(),
  endAt: z.string().datetime({ offset: true }).nullable().optional(),
  excludeFromComposite: z.boolean().optional(),
});

export type InsertDeviation = z.infer<typeof insertDeviationSchema>;
export type UpdateDeviation = z.infer<typeof updateDeviationSchema>;
export type Deviation = typeof deviations.$inferSelect;
