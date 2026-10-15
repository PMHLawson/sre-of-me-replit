import type { Domain, PolicyStateResponse, EscalationStateResponse } from "./schema";
export type TextAvailability = "absent" | "not_loaded";
export interface SessionSummary {
  id:string; userId:string; domain:Domain; durationMinutes:number; timestamp:string;
  deletedAt:string|null; isAnomaly:boolean; notes:null; anomalyNote:null;
  hasNotes:boolean; hasAnomalyNote:boolean; notesBytes:number; anomalyNoteBytes:number;
  notesAvailability:TextAvailability; anomalyNoteAvailability:TextAvailability;
}
export interface DeviationSummary {
  id:string; userId:string; domain:Domain; reason:string; startAt:string; endAt:string|null;
  endedAt:string|null; deletedAt:string|null; excludeFromComposite:boolean;
  hasReason:boolean; reasonBytes:number; reasonAvailability:TextAvailability;
}
/** complete means end of THIS explicitly paged collection, never calculation completeness. */
export interface HistoryPage<T> { items:T[]; nextCursor:string|null; complete:boolean }
export type TextDetail<T> = T & {textVersion:string};
export interface TextChunk {
  text:string|null; offset:number; nextOffset:number|null; textVersion:string; bytes:number;
}
export interface SessionStateBundle {
  ownerUserId:string; asOf:string; complete:true;
  context:{sessions:SessionSummary[];deviations:DeviationSummary[];fromInclusive:string;complete:true};
  policyState:PolicyStateResponse; escalationState:EscalationStateResponse;
}
