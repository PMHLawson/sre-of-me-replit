import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, numeric, timestamp, boolean, jsonb, primaryKey, unique, foreignKey, check, type AnyPgColumn } from "drizzle-orm/pg-core";
import { users } from "./models/auth";
import type { DomainConfiguration, Observation, MeasurementDefinition } from "./domain-config";
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
  // Preserve the existing opaque identifier contract; never normalize an ID.
  excludeSessionId: z.string().min(1).optional(),
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
// Check content without transforming the supplied explanation. In particular,
// max(500) applies to the original text, including intentional padding.
const explanationSchema = z.string().min(1).max(500).refine(
  value => value.trim().length > 0,
  { message: "Explanation must contain non-whitespace text" },
);

export const updateSessionSchema = z.object({
  domain: z.enum(domainEnum).optional(),
  durationMinutes: z.number().int().positive().optional(),
  timestamp: z.string().datetime({ offset: true }).optional(),
  notes: z.string().nullable().optional(),
  reason: explanationSchema,
  // C1.1 — Anomaly fields mirror insertSessionSchema so the edit path can
  // persist a re-evaluated flag when the duration changes.
  isAnomaly: z.boolean().optional(),
  anomalyNote: z.string().nullable().optional(),
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

/**
 * C2.3 — Per-domain trailing run of consecutive overachievement days.
 * `consecutiveDays` is 0 when the most recent day was NONE; `tier` is the
 * tier of the most recent day in the streak (or NONE).
 */
export const sustainedOverachievementEntrySchema = z.object({
  consecutiveDays: z.number(),
  tier: z.enum(overachievementTierEnum),
});
export type SustainedOverachievementEntry = z.infer<typeof sustainedOverachievementEntrySchema>;

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
  /**
   * C2.3 — Per-domain sustained-overachievement runs, shaped for future
   * notification triggers (e.g. fire when consecutiveDays >= N for tier T).
   */
  sustainedOverachievement: z.record(z.enum(domainEnum), sustainedOverachievementEntrySchema),
  /**
   * SOMR-327 — Server-authoritative logical-day key sets for all chart ranges
   * and the fixed Current/Previous 7-day summary windows. The client uses
   * these to bucket sessions without mirroring the logical-day algorithm.
   *
   *   w7    — 7 most-recent completed logical days (oldest→newest)
   *   w14   — 14 completed logical days
   *   w28   — 28 completed logical days
   *   w42   — 42 completed logical days (full chart backing store)
   *   prev7 — 7 days immediately preceding w7; no gap, no overlap
   */
  windowSets: z.object({
    w7:    z.array(z.string()),
    w14:   z.array(z.string()),
    w28:   z.array(z.string()),
    w42:   z.array(z.string()),
    prev7: z.array(z.string()),
    /**
     * SOMR-327 — Maps each active deviation's id to the subset of w42 logical-day
     * keys it overlaps, computed from the authoritative logical-day boundaries
     * (timezone + dayStartHour).  The client uses this to render deviation bands
     * without any client-side timezone arithmetic or UTC-midnight approximation.
     */
    deviationDayMap: z.record(z.string(), z.array(z.string())).optional(),
    /**
     * SOMR-327 — The server-computed logical-day key for the *current* (in-progress)
     * day, using the same timezone + dayStartHour as the window sets.  Lets the
     * client identify today's sessions without any client-side TZ arithmetic.
     * Today is NOT included in any window set (w7 … w42) — it is strictly live
     * operational context, excluded from all SLO and trend calculations.
     */
    todayKey: z.string().optional(),
  }).optional(),
  /**
   * SOMR-327 — Maps each session's id to its server-computed logical-day key
   * (YYYY-MM-DD, in the user's configured timezone + day-start hour). Lets
   * the client bucket sessions into windows without a client-side
   * logical-day implementation.
   */
  sessionDays: z.record(z.string(), z.string()).optional(),
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
    reason: explanationSchema,
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }).nullable().optional(),
    excludeFromComposite: z.boolean().optional(),
  });

export const updateDeviationSchema = z.object({
  reason: explanationSchema.optional(),
  startAt: z.string().datetime({ offset: true }).optional(),
  endAt: z.string().datetime({ offset: true }).nullable().optional(),
  excludeFromComposite: z.boolean().optional(),
});

export type InsertDeviation = z.infer<typeof insertDeviationSchema>;
export type UpdateDeviation = z.infer<typeof updateDeviationSchema>;
export type Deviation = typeof deviations.$inferSelect;

// ----- User settings (C3.1) -----
// Per-user runtime knobs for the policy engine + Phase 1 notification preferences.
// One row per user (PK = userId text to match users.id varchar). Auto-created
// with safe defaults on first read so existing users are unaffected.

export const notificationTierEnum = ["ADVISORY", "WARNING", "BREACH", "PAGE"] as const;
export type NotificationTier = typeof notificationTierEnum[number];

export const complianceWindowDayOptions = [7, 14, 28, 42] as const;
export type ComplianceWindowDays = typeof complianceWindowDayOptions[number];

export const complianceWindowDaysSchema = z.union([
  z.literal(7),
  z.literal(14),
  z.literal(28),
  z.literal(42),
]);

/**
 * Convert legacy compliance-window selections to the accepted weekly standard.
 * 21 and 30 were previously selectable; both resolve to the canonical 28-day
 * window. Unexpected database values fall back to the unchanged 7-day default.
 */
export function normalizeComplianceWindowDays(windowDays: number): ComplianceWindowDays {
  if (windowDays === 21 || windowDays === 30) return 28;
  if (complianceWindowDayOptions.includes(windowDays as ComplianceWindowDays)) {
    return windowDays as ComplianceWindowDays;
  }
  return 7;
}

export const userSettings = pgTable("user_settings", {
  userId: text("user_id").primaryKey(),
  dayStartHour: integer("day_start_hour").notNull().default(4),
  timezone: text("timezone").notNull().default("America/New_York"),
  windowDays: integer("window_days").notNull().default(7),
  notificationsEnabled: boolean("notifications_enabled").notNull().default(false),
  notificationTier: text("notification_tier").notNull().default("WARNING"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertUserSettingsSchema = createInsertSchema(userSettings)
  .omit({ userId: true, updatedAt: true })
  .extend({
    dayStartHour: z.coerce.number().int().min(0).max(23).optional(),
    timezone: z.string().min(1).max(64).optional(),
    windowDays: z.coerce.number().pipe(complianceWindowDaysSchema).optional(),
    notificationsEnabled: z.coerce.boolean().optional(),
    notificationTier: z.enum(notificationTierEnum).optional(),
  })
  .partial();

export const selectUserSettingsSchema = z.object({
  userId: z.string(),
  dayStartHour: z.number().int().min(0).max(23),
  timezone: z.string().min(1).max(64),
  windowDays: complianceWindowDaysSchema,
  notificationsEnabled: z.boolean(),
  notificationTier: z.enum(notificationTierEnum),
  updatedAt: z.date(),
});

export type InsertUserSettings = z.infer<typeof insertUserSettingsSchema>;
export type UserSettings = typeof userSettings.$inferSelect;
export type SelectUserSettings = z.infer<typeof selectUserSettingsSchema>;

// Additive storage only; full validation and immutable writes are future work.
const instant = (name: string) => timestamp(name, { withTimezone: true });
const identityMatch = (payload: AnyPgColumn, key: string, column: AnyPgColumn) =>
  sql`(jsonb_typeof(${payload}->${sql.raw(`'${key}'`)}) = 'string' AND ${payload}->>${sql.raw(`'${key}'`)} = ${column}) IS TRUE`;
export const organizations = pgTable("organizations", {
  orgId: text("org_id").primaryKey(), displayName: text("display_name").notNull(),
  rolloutMode: text("rollout_mode").notNull().default("legacy"),
  createdAt: instant("created_at").notNull().defaultNow(), updatedAt: instant("updated_at").notNull().defaultNow(),
}, t => [check("organizations_rollout", sql`${t.rolloutMode} IN ('legacy','shadow','v2')`)]);
export const organizationMembers = pgTable("organization_members", {
  orgId: text("org_id").notNull().references(() => organizations.orgId),
  userId: text("user_id").notNull().references(() => users.id), role: text("role").notNull(),
  createdAt: instant("created_at").notNull().defaultNow(), updatedAt: instant("updated_at").notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.orgId,t.userId] }), check("members_role", sql`${t.role} IN ('owner','member')`)]);
export const domains = pgTable("domains", {
  domainId: text("domain_id").primaryKey(), orgId: text("org_id").notNull().references(() => organizations.orgId),
  ownerUserId: text("owner_user_id").notNull(), slug: text("slug").notNull(), displayName: text("display_name").notNull(),
  deactivatedAt: instant("deactivated_at"), tombstonedAt: instant("tombstoned_at"),
}, t => [
  unique("domains_scope").on(t.orgId,t.ownerUserId,t.domainId), unique("domains_slug").on(t.orgId,t.slug),
  foreignKey({ name:"domains_member",columns:[t.orgId,t.ownerUserId],foreignColumns:[organizationMembers.orgId,organizationMembers.userId] }),
]);
export const policyVersions = pgTable("policy_versions", {
  policyVersionId:text("policy_version_id").primaryKey(), orgId:text("org_id").notNull().references(()=>organizations.orgId),
  ownerUserId:text("owner_user_id").notNull(),domainId:text("domain_id").notNull(),
  revision:integer("revision").notNull(),effectiveFrom:instant("effective_from").notNull(),previousVersionId:text("previous_version_id"),
  configuration:jsonb("configuration").$type<DomainConfiguration>().notNull(),evaluationPolicy:jsonb("evaluation_policy").$type<Record<string,unknown>>(),
},t=>[
  unique("policy_scope").on(t.orgId,t.ownerUserId,t.domainId,t.policyVersionId),unique("policy_revision").on(t.orgId,t.domainId,t.revision),
  foreignKey({name:"policy_domain",columns:[t.orgId,t.ownerUserId,t.domainId],foreignColumns:[domains.orgId,domains.ownerUserId,domains.domainId]}),
  foreignKey({name:"policy_predecessor",columns:[t.orgId,t.ownerUserId,t.domainId,t.previousVersionId],foreignColumns:[t.orgId,t.ownerUserId,t.domainId,t.policyVersionId]}),
  check("policy_revision_positive",sql`${t.revision}>0`),
  check("policy_predecessor_rule",sql`(${t.revision}=1)=(${t.previousVersionId} IS NULL) AND (${t.previousVersionId} IS NULL OR ${t.previousVersionId}<>${t.policyVersionId})`),
  check("policy_configuration_object",sql`jsonb_typeof(${t.configuration})='object'`),
  check("policy_configuration_identity",sql`${identityMatch(t.configuration,"organizationId",t.orgId)} AND ${identityMatch(t.configuration,"ownerUserId",t.ownerUserId)} AND ${identityMatch(t.configuration,"domainId",t.domainId)} AND ${identityMatch(t.configuration,"policyVersionId",t.policyVersionId)}`),
  check("policy_configuration_revision",sql`(jsonb_typeof(${t.configuration}->'revision')='number' AND ${t.configuration}->'revision'=to_jsonb(${t.revision})) IS TRUE`),
  check("policy_configuration_predecessor",sql`(CASE WHEN ${t.previousVersionId} IS NULL THEN NOT (${t.configuration} ? 'previousVersionId') ELSE ${identityMatch(t.configuration,"previousVersionId",t.previousVersionId)} END) IS TRUE`),
]);
export const dimensionDefinitions=pgTable("dimension_definitions",{
  orgId:text("org_id").notNull().references(()=>organizations.orgId),ownerUserId:text("owner_user_id").notNull(),domainId:text("domain_id").notNull(),
  policyVersionId:text("policy_version_id").notNull(),measurementId:text("measurement_id").notNull(),definition:jsonb("definition").$type<MeasurementDefinition>().notNull(),
},t=>[
  primaryKey({columns:[t.policyVersionId,t.measurementId]}),
  foreignKey({name:"dimension_policy",columns:[t.orgId,t.ownerUserId,t.domainId,t.policyVersionId],foreignColumns:[policyVersions.orgId,policyVersions.ownerUserId,policyVersions.domainId,policyVersions.policyVersionId]}),
  check("dimension_object",sql`jsonb_typeof(${t.definition})='object'`),check("dimension_identity",identityMatch(t.definition,"measurementId",t.measurementId)),
]);
export const observations=pgTable("observations",{
  observationId:text("observation_id").primaryKey(),orgId:text("org_id").notNull().references(()=>organizations.orgId),
  ownerUserId:text("owner_user_id").notNull(),domainId:text("domain_id").notNull(),policyVersionId:text("policy_version_id").notNull(),
  idempotencyKey:text("idempotency_key").notNull(),observedAt:instant("observed_at").notNull(),observation:jsonb("observation").$type<Observation>().notNull(),
  isAnomaly:boolean("is_anomaly").notNull().default(false),anomalyNote:text("anomaly_note"),deletedAt:instant("deleted_at"),
  legacySourceType:text("legacy_source_type"),legacySourceId:text("legacy_source_id"),
},t=>[
  unique("observation_idempotency").on(t.idempotencyKey),unique("observation_legacy_source").on(t.orgId,t.ownerUserId,t.domainId,t.legacySourceType,t.legacySourceId),
  foreignKey({name:"observation_policy",columns:[t.orgId,t.ownerUserId,t.domainId,t.policyVersionId],foreignColumns:[policyVersions.orgId,policyVersions.ownerUserId,policyVersions.domainId,policyVersions.policyVersionId]}),
  check("observation_legacy_pair",sql`(${t.legacySourceType} IS NULL)=(${t.legacySourceId} IS NULL)`),
  check("observation_object",sql`jsonb_typeof(${t.observation})='object'`),
  check("observation_identity",sql`${identityMatch(t.observation,"organizationId",t.orgId)} AND ${identityMatch(t.observation,"ownerUserId",t.ownerUserId)} AND ${identityMatch(t.observation,"domainId",t.domainId)} AND ${identityMatch(t.observation,"policyVersionId",t.policyVersionId)} AND ${identityMatch(t.observation,"observationId",t.observationId)}`),
]);
export const evaluationResults=pgTable("evaluation_results",{
  resultId:text("result_id").primaryKey(),orgId:text("org_id").notNull().references(()=>organizations.orgId),
  ownerUserId:text("owner_user_id").notNull(),domainId:text("domain_id").notNull(),policyVersionId:text("policy_version_id").notNull(),
  windowStart:instant("window_start").notNull(),windowEnd:instant("window_end").notNull(),timezone:text("timezone").notNull(),dayStartHour:integer("day_start_hour").notNull(),
  calculatedAt:instant("calculated_at").notNull(),calculationVersion:text("calculation_version").notNull(),inputFingerprint:text("input_fingerprint").notNull(),
  eligibleDays:numeric("eligible_days").notNull(),result:jsonb("result").notNull(),components:jsonb("components").notNull(),explanation:jsonb("explanation").notNull(),
  budgetSnapshot:jsonb("budget_snapshot"),budgetEnabledSnapshot:boolean("budget_enabled_snapshot").notNull().default(false),
},t=>[
  unique("evaluation_window").on(t.orgId,t.domainId,t.windowStart,t.windowEnd,t.policyVersionId,t.calculationVersion),
  foreignKey({name:"evaluation_policy",columns:[t.orgId,t.ownerUserId,t.domainId,t.policyVersionId],foreignColumns:[policyVersions.orgId,policyVersions.ownerUserId,policyVersions.domainId,policyVersions.policyVersionId]}),
  check("evaluation_order",sql`${t.windowEnd}>${t.windowStart}`),check("evaluation_day_boundary",sql`${t.dayStartHour} BETWEEN 0 AND 23`),
  check("evaluation_eligible",sql`${t.eligibleDays}>=0 AND ${t.eligibleDays}::text NOT IN ('NaN','Infinity','-Infinity')`),check("evaluation_budget",sql`${t.budgetEnabledSnapshot} OR ${t.budgetSnapshot} IS NULL`),
]);
export const deviationsV2=pgTable("deviations_v2",{
  deviationId:text("deviation_id").primaryKey(),orgId:text("org_id").notNull().references(()=>organizations.orgId),ownerUserId:text("owner_user_id").notNull(),
  startAt:instant("start_at").notNull(),endAt:instant("end_at"),endedAt:instant("ended_at"),deletedAt:instant("deleted_at"),
  scope:text("scope").notNull(),type:text("type").notNull(),reason:text("reason").notNull(),policy:jsonb("policy").notNull(),provenance:jsonb("provenance").notNull(),
},t=>[
  unique("deviation_scope").on(t.orgId,t.ownerUserId,t.deviationId),
  foreignKey({name:"deviation_member",columns:[t.orgId,t.ownerUserId],foreignColumns:[organizationMembers.orgId,organizationMembers.userId]}),
  check("deviation_interval",sql`(${t.endAt} IS NULL OR ${t.endAt}>${t.startAt}) AND (${t.endedAt} IS NULL OR ${t.endedAt}>=${t.startAt})`),
  check("deviation_scope_kind",sql`${t.scope} IN ('all','selected')`),check("deviation_type",sql`${t.type} IN ('stitch','substitute_target')`),
]);
export const deviationDomains=pgTable("deviation_domains",{
  orgId:text("org_id").notNull().references(()=>organizations.orgId),ownerUserId:text("owner_user_id").notNull(),deviationId:text("deviation_id").notNull(),domainId:text("domain_id").notNull(),
},t=>[
  primaryKey({columns:[t.deviationId,t.domainId]}),
  foreignKey({name:"deviation_domain_deviation",columns:[t.orgId,t.ownerUserId,t.deviationId],foreignColumns:[deviationsV2.orgId,deviationsV2.ownerUserId,deviationsV2.deviationId]}),
  foreignKey({name:"deviation_domain_domain",columns:[t.orgId,t.ownerUserId,t.domainId],foreignColumns:[domains.orgId,domains.ownerUserId,domains.domainId]}),
]);
export const auditEvents=pgTable("audit_events",{
  auditEventId:text("audit_event_id").primaryKey(),orgId:text("org_id").notNull().references(()=>organizations.orgId),
  actorKind:text("actor_kind").notNull(),actorUserId:text("actor_user_id"),entityType:text("entity_type").notNull(),entityId:text("entity_id").notNull(),
  action:text("action").notNull(),occurredAt:instant("occurred_at").notNull(),reason:text("reason"),before:jsonb("before"),after:jsonb("after"),
},t=>[
  foreignKey({name:"audit_actor",columns:[t.orgId,t.actorUserId],foreignColumns:[organizationMembers.orgId,organizationMembers.userId]}),
  check("audit_actor_kind",sql`${t.actorKind} IN ('user','system')`),check("audit_actor_required",sql`${t.actorKind}<>'user' OR ${t.actorUserId} IS NOT NULL`),
]);
export const sourceBindings=pgTable("source_bindings",{
  bindingId:text("binding_id").primaryKey(),orgId:text("org_id").notNull().references(()=>organizations.orgId),
  ownerUserId:text("owner_user_id").notNull(),domainId:text("domain_id").notNull(),sourceKind:text("source_kind").notNull(),externalId:text("external_id").notNull(),metadata:jsonb("metadata"),
},t=>[
  unique("binding_external").on(t.orgId,t.sourceKind,t.externalId),
  foreignKey({name:"binding_domain",columns:[t.orgId,t.ownerUserId,t.domainId],foreignColumns:[domains.orgId,domains.ownerUserId,domains.domainId]}),
]);
