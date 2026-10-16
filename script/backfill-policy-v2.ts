/**
 * INERT seed-only placeholder. No CLI, connection, environment lookup or startup.
 * Runtime adoption/backfill requires a separate reviewed release.
 */
import { BoundaryError } from "../server/lib/org-context";
export function backfillPolicyV2():never {
  throw new BoundaryError(403);
}