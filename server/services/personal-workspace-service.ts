import { randomUUID } from "node:crypto";
import { OnboardingReadySchema, OnboardingSettingsSchema, OnboardingSettingsPatchSchema,
  WorkspaceEnsureInputSchema, type OnboardingReady, type OnboardingStatus, type OnboardingSettings } from "../../shared/onboarding";
import { authenticatedBootstrapActor, type BootstrapUnit, type createAuthenticatedBootstrapUnit } from "../lib/authenticated-bootstrap-unit";
import { createAuditService } from "../lib/audit-service";
import { assertContext, revalidate, BoundaryError, type OrgContext } from "../lib/org-context";

type Units = ReturnType<typeof createAuthenticatedBootstrapUnit>;
type Request = Parameters<Units["run"]>[0];
async function memberships(unit: BootstrapUnit) {
  return (await unit.tx.query(
    "SELECT org_id,user_id,role,created_at,updated_at FROM public.organization_members WHERE user_id=$1 ORDER BY org_id FOR SHARE",
    [unit.actorUserId])).rows;
}
async function ready(unit: BootstrapUnit, context: OrgContext): Promise<OnboardingReady> {
  assertContext(unit.db, context); await revalidate(unit.tx, unit.db, context);
  const scope = [context.orgId, context.actorUserId];
  const settings = await unit.tx.query("SELECT user_id,day_start_hour,timezone,window_days FROM public.user_settings WHERE user_id=$1", [context.actorUserId]);
  if (settings.rows.length > 1) throw new BoundaryError(503);
  const s = settings.rows[0];
  // A navigation discriminator only; this grants no API authority. Both joins
  // retain org+owner scope so a same-org colleague's seed is not disclosed.
  const projection = await unit.tx.query(`SELECT
    EXISTS (SELECT 1 FROM public.source_bindings b JOIN public.domains d
      ON d.org_id=b.org_id AND d.owner_user_id=b.owner_user_id AND d.domain_id=b.domain_id
      WHERE b.org_id=$1 AND b.owner_user_id=$2 AND b.source_kind='manual-legacy'
      AND b.metadata->>'description'='existing-owner-seed-v1') AS legacy,
    EXISTS (SELECT 1 FROM public.domains d JOIN public.policy_versions p
      ON p.org_id=d.org_id AND p.owner_user_id=d.owner_user_id AND p.domain_id=d.domain_id
      WHERE d.org_id=$1 AND d.owner_user_id=$2 AND d.deactivated_at IS NULL AND d.tombstoned_at IS NULL) AS configured`, scope);
  if (projection.rows.length !== 1) throw new BoundaryError(503);
  const result = OnboardingReadySchema.safeParse({ schemaVersion: 1, ownerUserId: context.actorUserId, status: "ready",
    workspace: { organizationId: context.orgId, role: context.role },
    experience: projection.rows[0].legacy === true ? "legacy" : "personal",
    hasConfiguredDomain: projection.rows[0].configured,
    settings: s ? { userId: s.user_id, dayStartHour: s.day_start_hour, timezone: s.timezone, windowDays: s.window_days } : null,
  });
  if (!result.success || typeof projection.rows[0].legacy !== "boolean") throw new BoundaryError(503);
  return result.data;
}

/** Existing tables only; no history/template, identity or rollout overrides. */
export function createPersonalWorkspaceService(units: Units) {
  if (!units || typeof units.run !== "function") throw new BoundaryError(503);
  return Object.freeze({
    status: (request: Request): Promise<OnboardingStatus> => units.run<OnboardingStatus>(request, async unit => {
      const found = await memberships(unit);
      if (found.length === 0) return { schemaVersion: 1, ownerUserId: unit.actorUserId, status: "needs_workspace" };
      if (found.length !== 1) throw new BoundaryError(403);
      return ready(unit, await unit.resolveContext());
    }),
    readSettings: (request: Request): Promise<OnboardingSettings> => units.run<OnboardingSettings>(request, async unit => {
      const found = await memberships(unit);
      if (found.length !== 1) throw new BoundaryError(403);
      const result = await ready(unit, await unit.resolveContext());
      if (result.settings === null) throw new BoundaryError(503);
      return result.settings;
    }),
    updateSettings: async (request: Request, input: unknown): Promise<OnboardingSettings> => {
      authenticatedBootstrapActor(request);
      const parsed = OnboardingSettingsPatchSchema.safeParse(input);
      if (!parsed.success) throw new BoundaryError(400);
      return units.run<OnboardingSettings>(request, async unit => {
        const found = await memberships(unit);
        if (found.length !== 1) throw new BoundaryError(403);
        const context = await unit.resolveContext();
        assertContext(unit.db, context); await revalidate(unit.tx, unit.db, context);
        const selected = await unit.tx.query("SELECT * FROM public.user_settings WHERE user_id=$1 FOR UPDATE", [context.actorUserId]);
        if (selected.rows.length !== 1) throw new BoundaryError(503);
        const before = selected.rows[0];
        const projection = (row: typeof before) => OnboardingSettingsSchema.safeParse({ userId: row.user_id,
          dayStartHour: row.day_start_hour, timezone: row.timezone, windowDays: row.window_days });
        const existing = projection(before);
        if (!existing.success || existing.data.userId !== context.actorUserId) throw new BoundaryError(503);
        // These identifiers are fixed server literals; every supplied value is
        // bound separately. No legacy normalization/default insertion occurs.
        const fields = ["dayStartHour", "timezone", "windowDays"] as const;
        const columns = { dayStartHour: "day_start_hour", timezone: "timezone", windowDays: "window_days" } as const;
        const changed = fields.filter(field => parsed.data[field] !== undefined && parsed.data[field] !== existing.data[field]);
        if (!changed.length) return existing.data;
        const values: unknown[] = [context.actorUserId, ...changed.map(field => parsed.data[field])];
        const assignments = changed.map((field, index) => `${columns[field]}=$${index + 2}`);
        const updated = await unit.tx.query(`UPDATE public.user_settings SET ${assignments.join(",")},updated_at=now()
          WHERE user_id=$1 RETURNING *`, values);
        if (updated.rows.length !== 1) throw new BoundaryError(503);
        const after = updated.rows[0], saved = projection(after);
        if (!saved.success || saved.data.userId !== context.actorUserId ||
          fields.some(field => saved.data[field] !== (parsed.data[field] ?? existing.data[field])) ||
          after.notifications_enabled !== before.notifications_enabled || after.notification_tier !== before.notification_tier)
          throw new BoundaryError(503);
        await createAuditService(unit.tx, unit.db, context).append("user_settings", [context.actorUserId], "update",
          "Personal day settings update", before, after);
        return saved.data;
      });
    },
    ensure: async (request: Request, input: unknown): Promise<OnboardingReady> => {
      authenticatedBootstrapActor(request); // authentication precedes input validation and DB access
      if (!WorkspaceEnsureInputSchema.safeParse(input).success) throw new BoundaryError(400);
      return units.run<OnboardingReady>(request, async unit => {
        const found = await memberships(unit);
        if (found.length > 1) throw new BoundaryError(403);
        if (found.length === 1) return ready(unit, await unit.resolveContext()); // strictly no-op
        const organizationId = randomUUID();
        const organization = await unit.tx.query(`INSERT INTO public.organizations (org_id,display_name)
          VALUES ($1,'Personal workspace') RETURNING *`, [organizationId]);
        const membership = await unit.tx.query(`INSERT INTO public.organization_members (org_id,user_id,role)
          VALUES ($1,$2,'owner') RETURNING *`, [organizationId, unit.actorUserId]);
        const settings = await unit.tx.query(`INSERT INTO public.user_settings (user_id)
          VALUES ($1) ON CONFLICT (user_id) DO NOTHING RETURNING *`, [unit.actorUserId]);
        if (organization.rows.length !== 1 || membership.rows.length !== 1 || settings.rows.length > 1) throw new BoundaryError(503);
        const context = await unit.resolveContext();
        if (context.orgId !== organizationId || context.role !== "owner") throw new BoundaryError(403);
        const audit = createAuditService(unit.tx, unit.db, context);
        const reason = "Personal workspace first setup";
        await audit.append("organizations", [organizationId], "create", reason, null, organization.rows[0]);
        await audit.append("organization_members", [organizationId, unit.actorUserId], "create", reason, null, membership.rows[0]);
        if (settings.rows.length === 1) await audit.append("user_settings", [unit.actorUserId], "create", reason, null, settings.rows[0]);
        return ready(unit, context);
      });
    },
  });
}
