import React, { useEffect, useState } from "react";
import { useAppStore, type Session, type Deviation } from "@/store";

/** Full text is fetched only on an explicit open. Each click advances one chunk per field. */
export function SessionText({ session, force = false }: { session: Session; force?: boolean }) {
  return <RecordText kind="sessions" record={session} force={force} />;
}
export function DeviationText({ deviation, force = false }: { deviation: Deviation; force?: boolean }) {
  return <RecordText kind="deviations" record={deviation} force={force} />;
}
function RecordText({ kind, record, force }: { kind: "sessions" | "deviations"; record: Session | Deviation; force: boolean }) {
  const [opened, setOpened] = useState(force);
  const entry = useAppStore(s => kind === "sessions" ? s.sessionDetails[record.id] : s.deviationDetails[record.id]);
  const fetchSession = useAppStore(s => s.fetchSessionDetail);
  const fetchDeviation = useAppStore(s => s.fetchDeviationDetail);
  const load = (more = false) => kind === "sessions" ? fetchSession(record.id, more) : fetchDeviation(record.id, more);
  useEffect(() => { if (force && !entry) void load(); }, [force, record.id, entry?.status]);
  const has = kind === "sessions" ? (record as Session).hasNotes || (record as Session).hasAnomalyNote :
    (record as Deviation).hasReason;
  if (record.textComplete !== false) {
    return <div className="whitespace-pre-wrap break-words text-sm">
      {kind === "sessions" ? <>{(record as Session).notes}{(record as Session).anomalyNote && <p>Anomaly: {(record as Session).anomalyNote}</p>}</> :
        (record as Deviation).reason}
    </div>;
  }
  if (!force && !has) return null;
  if (!opened) return <button className="text-xs underline" onClick={() => { setOpened(true); void load(); }}>Read saved text</button>;
  return <div className="space-y-2 text-sm" data-testid={"saved-text-" + record.id}>
    {entry?.value && <div className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
      {kind === "sessions" ? <>{(entry.value as Session).notes}
        {(entry.value as Session).anomalyNote && <p>Anomaly: {(entry.value as Session).anomalyNote}</p>}</> :
        (entry.value as Deviation).reason}
    </div>}
    {entry?.status === "loading" && <p role="status">Loading saved text…</p>}
    {entry?.status === "error" && <p role="alert">{entry.error}</p>}
    {entry?.status === "incomplete" && <><p>More saved text remains. Editing stays disabled until all text is loaded.</p>
      <button className="underline" onClick={() => void load(true)}>Load more text</button></>}
    {(!entry || entry.status === "error") && <button className="underline" onClick={() => void load()}>Restart loading text</button>}
    {entry?.status === "ready" && <p className="text-xs text-muted-foreground">Complete saved text</p>}
  </div>;
}
