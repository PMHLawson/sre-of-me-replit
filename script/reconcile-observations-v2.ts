import { BoundaryError } from "../server/lib/org-context";

/** INERT. No CLI, connection, environment lookup, startup or enable flag. */
export function reconcileObservationsV2(): never {
  throw new BoundaryError(403);
}