import type { Session, SessionPatch, Domain } from "@/store";
export interface SessionEditDraft {
  domain: Domain; durationMinutes: number; timestamp?: string;
  /** undefined means untouched; empty string is the form's explicit clear action. */
  notes?: string;
}
/** No text trimming, normalization, length change or inferred missing-detail value. */
export function sessionEditFields(saved: Session, draft: SessionEditDraft): SessionPatch {
  return {
    ...(draft.domain !== saved.domain ? { domain: draft.domain } : {}),
    ...(draft.durationMinutes !== saved.durationMinutes ? { durationMinutes: draft.durationMinutes } : {}),
    ...(draft.timestamp !== undefined && draft.timestamp !== saved.timestamp ? { timestamp: draft.timestamp } : {}),
    ...(draft.notes !== undefined && draft.notes !== (saved.notes ?? "") ?
      { notes: draft.notes === "" ? null : draft.notes } : {}),
  };
}
