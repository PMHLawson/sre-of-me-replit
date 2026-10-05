import type { Response } from "express";
import type { Pool } from "pg";
import { BoundaryError } from "../lib/org-context";
import { createPinnedOwnershipUnit } from "../lib/pinned-ownership-unit";
import { createLegacyActivityMutations } from "./legacy-activity-mutations";

type Request = Parameters<ReturnType<typeof createLegacyActivityMutations>["create"]>[0];
type Action = "create" | "edit" | "softDelete" | "restore";
export interface LegacyWriteThroughConfig { readonly enabled: boolean; readonly owners: readonly string[] }
export type LegacySessionAdapter = ReturnType<typeof createLegacySessionAdapter>;
const validActor = (actor: unknown): actor is string => typeof actor === "string" && actor.length > 0 && actor.length <= 200 &&
  actor.trim() === actor && !/[\u0000-\u001f\u007f]/.test(actor) && actor !== "__proto__" && actor !== "*";
const unavailable = () => new BoundaryError(503);

/** Server configuration only. No request field can select or activate adoption. */
export function readLegacyWriteThroughConfig(env: Record<string, string | undefined>): LegacyWriteThroughConfig {
  const flag = env.SOMR_LEGACY_WRITE_THROUGH;
  if (flag === undefined || flag === "" || flag === "disabled") return Object.freeze({ enabled: false, owners: Object.freeze([]) });
  // Legacy expiry deletion cannot preserve the new canonical/audit lineage.
  if (flag !== "enabled" || env.SESSION_RETENTION_PURGE_ENABLED === "true") throw unavailable();
  try {
    const owners: unknown = JSON.parse(env.SOMR_LEGACY_WRITE_THROUGH_OWNER_IDS ?? "");
    if (!Array.isArray(owners) || owners.length === 0 || owners.length > 100 || !owners.every(validActor) || new Set(owners).size !== owners.length)
      throw unavailable();
    return Object.freeze({ enabled: true, owners: Object.freeze(owners.slice()) });
  } catch { throw unavailable(); }
}

function publicSession(row: Record<string, any>) {
  const timestamp = new Date(row.timestamp), deletedAt = row.deleted_at === null ? null : new Date(row.deleted_at);
  if (typeof row.id !== "string" || typeof row.user_id !== "string" || !Number.isFinite(timestamp.getTime()) ||
    (deletedAt !== null && !Number.isFinite(deletedAt.getTime()))) throw unavailable();
  // Match the existing API's camelCase keys and ISO millisecond representation.
  // Exact database microseconds remain in the canonical row and audit snapshots.
  return { id: row.id, userId: row.user_id, domain: row.domain, durationMinutes: row.duration_minutes,
    timestamp: timestamp.toISOString(), notes: row.notes, deletedAt: deletedAt?.toISOString() ?? null,
    isAnomaly: row.is_anomaly, anomalyNote: row.anomaly_note };
}

/**
 * A disabled-by-default bridge for the four existing activity mutation routes.
 * The existing pool is injected lazily, never created or reconfigured here.
 * An opted-in owner's failure never falls back to an unsynchronized legacy write.
 * Seed/import, maintenance, migrations and new-user provisioning stay explicit.
 */
export function createLegacySessionAdapter(options: {
  config: LegacyWriteThroughConfig;
  getPool: () => Promise<Pick<Pool, "connect">>;
}) {
  if (!options || typeof options.getPool !== "function" || typeof options.config?.enabled !== "boolean" ||
    !Array.isArray(options.config.owners) || !options.config.owners.every(validActor) ||
    (options.config.enabled && options.config.owners.length === 0) || options.config.owners.length > 100 ||
    new Set(options.config.owners).size !== options.config.owners.length) throw unavailable();
  const enabled = options.config.enabled, owners = new Set(options.config.owners);
  const getPool = options.getPool;
  let prepared: Promise<ReturnType<typeof createLegacyActivityMutations>> | undefined;
  const select = async (request: Request) => {
    if (!enabled) return undefined;
    let actor: unknown;
    try {
      actor = (request?.user as { claims?: { sub?: unknown } } | undefined)?.claims?.sub;
      if (typeof request?.isAuthenticated !== "function" || request.isAuthenticated() !== true || !validActor(actor)) throw new BoundaryError(401);
    } catch { throw new BoundaryError(401); }
    if (!owners.has(actor)) return undefined;
    if (!prepared) prepared = Promise.resolve().then(getPool).then(pool => createLegacyActivityMutations(createPinnedOwnershipUnit(pool)));
    try { return await prepared; } catch { throw unavailable(); }
  };
  const invoke = async (request: Request, action: Action, keyOrInput: unknown, patch?: unknown) => {
    const service = await select(request); if (!service) return undefined;
    try {
      const row = action === "edit" ? await service.edit(request, keyOrInput, patch) : action === "create" ?
        await service.create(request, keyOrInput) : action === "softDelete" ? await service.softDelete(request, keyOrInput) : await service.restore(request, keyOrInput);
      return publicSession(row);
    } catch (error) { throw error instanceof BoundaryError ? error : unavailable(); }
  };
  return Object.freeze({
    create: (request: Request, input: unknown) => invoke(request, "create", input),
    edit: (request: Request, key: unknown, patch: unknown) => invoke(request, "edit", key, patch),
    softDelete: (request: Request, key: unknown) => invoke(request, "softDelete", key),
    restore: (request: Request, key: unknown) => invoke(request, "restore", key),
    respondError(error: unknown, response: Pick<Response, "status" | "json">, action: Action) {
      if (!(error instanceof BoundaryError)) return false;
      response.status(error.status).json({ message: error.status === 404 ?
        (action === "restore" ? "Deleted session not found" : "Session not found") : error.message });
      return true;
    },
  });
}
