import { BoundaryError } from "./org-context";
export const MAX_READ_ROWS=2000;
export const MAX_COLLECTION_ROWS=1000;
export const READ_TIMEOUT_MS=2500;
export class ResourceLimitError extends BoundaryError {
  readonly code="RESOURCE_LIMIT_EXCEEDED";
  constructor(){super(503);this.message="Requested history is unavailable at this size. Your records have not been changed.";}
}
