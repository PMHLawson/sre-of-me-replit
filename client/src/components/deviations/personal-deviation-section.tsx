import React, { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarOff, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { isActivityOwner, personalActivityEligibilityQuery } from "@/lib/activities-api";
import { PERSONAL_DOMAINS_QUERY, personalDomainBoundaryQuery, personalDomainsQuery } from "@/lib/domains-api";
import type { PersonalDomain } from "@/lib/domains-api";
import {
  createPersonalDeviation, deletePersonalDeviation, editPersonalDeviation, endPersonalDeviation,
  PERSONAL_DEVIATIONS_QUERY, personalDeviationsQuery, PersonalDeviationApiError,
} from "@/lib/deviation-v2-api";
import type { PersonalDeviation, PersonalDeviationCreate, PersonalDeviationEdit } from "@/lib/deviation-v2-api";
import { formatBreakTime } from "@/lib/deviation-time";
import { PersonalDeviationForm, type PersonalDeviationPracticeOption } from "./deviation-form";

type LifecycleConfirmation = { operation: "end" | "delete"; deviation: PersonalDeviation };

function ownedOptions<T>(ownerId: string, create: (id: string) => T): T | null {
  try { return isActivityOwner(ownerId) ? create(ownerId) : null; }
  catch { return null; }
}

function PersonalDeviationNotice({ loading, error, retry }: { loading?: boolean; error?: string; retry?: () => void }) {
  return <div className="rounded-2xl border border-border/60 bg-card p-4 text-sm" data-testid="personal-break-status">
    {loading ? <p role="status">Loading your saved breaks and active practices…</p> :
      <><p role="alert">{error ?? "Your personal breaks could not be verified. No changes are available until they reload."}</p>
        {retry && <button type="button" className="mt-2 underline" onClick={retry}>Reload breaks and practices</button>}</>}
  </div>;
}

function BreakCard({ deviation, names, timezone, onEdit, onEnd, onDelete }: {
  deviation: PersonalDeviation;
  names: Map<string, string>;
  timezone: string;
  onEdit: (row: PersonalDeviation) => void;
  onEnd: (row: PersonalDeviation) => void;
  onDelete: (row: PersonalDeviation) => void;
}) {
  const selectedNames = deviation.scope === "all" ? ["All practices"] :
    deviation.practiceIds.map(id => names.get(id) ?? `Saved practice (${id})`);
  const futureStart = Date.parse(deviation.startAt) > Date.now();
  return <article className="rounded-2xl border border-border/60 bg-card p-4 space-y-3" data-testid={`personal-break-${deviation.deviationId}`}>
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="font-semibold">{deviation.reason}</h3>
      {deviation.endedAt && <span className="rounded-full bg-muted px-2 py-1 text-xs">Ended</span>}
    </div>
    <p className="font-mono text-sm">{formatBreakTime(deviation.startAt, timezone)} – {deviation.endAt ? formatBreakTime(deviation.endAt, timezone) : "No planned end"} ({timezone})</p>
    <div className="flex flex-wrap gap-2" aria-label="Selected practices">
      {selectedNames.map((name, index) => <span key={`${deviation.practiceIds[index]}-${index}`}
        className="rounded-full border border-border/60 px-2 py-1 text-xs">{name}</span>)}
    </div>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={deviation.scope !== "selected"} onClick={() => onEdit(deviation)}
        data-testid={`button-edit-personal-break-${deviation.deviationId}`}>
        <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
      </Button>
      {deviation.scope !== "selected" && <p className="text-xs text-muted-foreground">This saved break uses the older all-practices scope and remains endable and deletable.</p>}
      {!deviation.endedAt && !futureStart && <Button size="sm" variant="outline" onClick={() => onEnd(deviation)}
        data-testid={`button-end-personal-break-${deviation.deviationId}`}><X className="mr-1 h-3.5 w-3.5" /> End now</Button>}
      <Button size="sm" variant="ghost" className="text-status-critical" onClick={() => onDelete(deviation)}
        data-testid={`button-delete-personal-break-${deviation.deviationId}`}><Trash2 className="mr-1 h-3.5 w-3.5" /> Delete</Button>
    </div>
  </article>;
}

/** V2 signed-in break lifecycle; the legacy deviation surface remains separate. */
export function PersonalDeviationSection({ ownerId }: { ownerId: string }) {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PersonalDeviation | null>(null);
  const [confirmation, setConfirmation] = useState<LifecycleConfirmation | null>(null);
  const [changeReason, setChangeReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSaving, setActionSaving] = useState(false);
  const ownsCurrentAccount = isActivityOwner(ownerId);
  const domainOptions = ownedOptions(ownerId, id => personalDomainsQuery(id));
  const boundaryOptions = ownedOptions(ownerId, id => personalDomainBoundaryQuery(id));
  const deviationOptions = ownedOptions(ownerId, id => personalDeviationsQuery(id));
  const domainsQuery = useQuery({ ...(domainOptions ?? {
    queryKey: [PERSONAL_DOMAINS_QUERY, "unavailable", "list", null] as const,
    queryFn: async () => { throw new PersonalDeviationApiError(401); }, staleTime: 0, gcTime: 0, retry: false as const,
  }), enabled: !!domainOptions });
  const boundaryQuery = useQuery({ ...(boundaryOptions ?? {
    queryKey: [PERSONAL_DOMAINS_QUERY, "unavailable", "boundary", null] as const,
    queryFn: async () => { throw new PersonalDeviationApiError(401); }, staleTime: 0, gcTime: 0, retry: false as const,
  }), enabled: !!boundaryOptions });
  const deviationsQuery = useQuery({ ...(deviationOptions ?? {
    queryKey: [PERSONAL_DEVIATIONS_QUERY, "unavailable"] as const,
    queryFn: async () => { throw new PersonalDeviationApiError(401); }, staleTime: 0, gcTime: 0, retry: false as const,
  }), enabled: !!deviationOptions });
  const domains = Array.isArray(domainsQuery.data) ? domainsQuery.data as PersonalDomain[] : [];
  const availabilityQueries = useQueries({
    queries: ownsCurrentAccount ? domains.map(domain => personalActivityEligibilityQuery(ownerId, domain.domainId)) : [],
  });
  const eligibilityReady = availabilityQueries.length === domains.length && availabilityQueries.every(query => query.isSuccess);
  const eligibilityFailed = availabilityQueries.some(query => query.isError);
  const practices = useMemo<PersonalDeviationPracticeOption[]>(() => domains.map((domain, index) => ({
    domainId: domain.domainId,
    displayName: domain.displayName,
    active: availabilityQueries[index]?.data?.domainId === domain.domainId &&
      availabilityQueries[index]?.data?.reason !== "inactive",
  })), [domains, availabilityQueries]);
  const names = useMemo(() => new Map(domains.map(domain => [domain.domainId, domain.displayName])), [domains]);
  const timezone = boundaryQuery.data?.timezone;
  const allLoaded = ownsCurrentAccount && domainsQuery.isSuccess && boundaryQuery.isSuccess &&
    deviationsQuery.isSuccess && eligibilityReady && !eligibilityFailed && !!timezone;

  useEffect(() => {
    queryClient.removeQueries({ predicate: query =>
      (query.queryKey[0] === PERSONAL_DEVIATIONS_QUERY || query.queryKey[0] === PERSONAL_DOMAINS_QUERY) &&
      query.queryKey[1] !== ownerId });
    setFormOpen(false);
    setEditing(null);
    setConfirmation(null);
    setChangeReason("");
    setActionError(null);
  }, [ownerId, queryClient]);

  const openCreate = () => { if (!isActivityOwner(ownerId)) return; setEditing(null); setFormOpen(true); };
  const openEdit = (deviation: PersonalDeviation) => {
    if (!isActivityOwner(ownerId) || deviation.scope !== "selected") return;
    setEditing(deviation); setFormOpen(true);
  };
  const submitForm = async (input: PersonalDeviationCreate | PersonalDeviationEdit): Promise<PersonalDeviation | null> => {
    if (!isActivityOwner(ownerId)) return null;
    const saved = editing ? await editPersonalDeviation(ownerId, editing, input as PersonalDeviationEdit) :
      await createPersonalDeviation(ownerId, input as PersonalDeviationCreate);
    if (!isActivityOwner(ownerId)) return null;
    await queryClient.invalidateQueries({ queryKey: [PERSONAL_DEVIATIONS_QUERY, ownerId] });
    return isActivityOwner(ownerId) ? saved : null;
  };
  const reloadSavedBreaks = async (): Promise<PersonalDeviation[]> => {
    if (!isActivityOwner(ownerId)) throw new PersonalDeviationApiError(401);
    const rows = await queryClient.fetchQuery({ ...personalDeviationsQuery(ownerId), staleTime: 0 });
    if (!isActivityOwner(ownerId)) throw new PersonalDeviationApiError(401);
    return rows;
  };
  const runLifecycle = async (event: React.MouseEvent, operation: "end" | "delete") => {
    event.preventDefault();
    if (!confirmation || confirmation.operation !== operation || actionSaving || !changeReason.trim() || !isActivityOwner(ownerId)) return;
    setActionSaving(true);
    setActionError(null);
    try {
      if (operation === "end") await endPersonalDeviation(ownerId, confirmation.deviation, changeReason.trim());
      else await deletePersonalDeviation(ownerId, confirmation.deviation, changeReason.trim());
      if (!isActivityOwner(ownerId)) return;
      await queryClient.invalidateQueries({ queryKey: [PERSONAL_DEVIATIONS_QUERY, ownerId] });
      if (isActivityOwner(ownerId)) setConfirmation(null);
    } catch {
      if (isActivityOwner(ownerId)) setActionError("The change was not confirmed. Your explanation is still here; refresh saved breaks before retrying.");
    } finally {
      setActionSaving(false);
    }
  };

  if (!ownsCurrentAccount) return null;
  const retry = () => {
    void domainsQuery.refetch(); void boundaryQuery.refetch(); void deviationsQuery.refetch();
    for (const query of availabilityQueries) void query.refetch();
  };
  if (domainsQuery.isPending || boundaryQuery.isPending || deviationsQuery.isPending ||
    (domainsQuery.isSuccess && availabilityQueries.some(query => query.isPending)))
    return <section className="space-y-3" data-testid="section-personal-breaks"><h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Breaks</h2>
      <PersonalDeviationNotice loading /></section>;
  if (!allLoaded) {
    const error = domainsQuery.error || boundaryQuery.error || deviationsQuery.error || availabilityQueries.find(query => query.isError)?.error;
    return <section className="space-y-3" data-testid="section-personal-breaks"><h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Breaks</h2>
      <PersonalDeviationNotice error={error instanceof Error ? error.message : "Active practices, saved timezone, and breaks could not all be verified."} retry={retry} /></section>;
  }

  const deviations = deviationsQuery.data ?? [];
  return <section className="space-y-3" data-testid="section-personal-breaks">
    <div className="flex items-center justify-between gap-3 px-2">
      <div><h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Personal breaks</h2>
        <p className="text-xs text-muted-foreground">Times use your saved timezone: {timezone}.</p></div>
      <Button size="sm" onClick={openCreate} disabled={!practices.some(practice => practice.active)} data-testid="button-create-personal-break">
        <Plus className="mr-1 h-4 w-4" /> Record break
      </Button>
    </div>
    {!practices.some(practice => practice.active) && <p className="rounded-xl border border-border/60 bg-card p-4 text-sm text-muted-foreground">
      No active personal practices are available for a new break.
    </p>}
    {deviations.length === 0 ? <div className="rounded-2xl border border-border/60 bg-card p-4 text-sm text-muted-foreground" data-testid="personal-breaks-empty">
      <CalendarOff className="mr-2 inline h-4 w-4" /> No personal breaks saved.
    </div> : <div className="space-y-3">{deviations.map(deviation => <BreakCard key={deviation.deviationId} deviation={deviation}
      names={names} timezone={timezone!} onEdit={openEdit}
      onEnd={row => { setConfirmation({ operation: "end", deviation: row }); setChangeReason(""); setActionError(null); }}
      onDelete={row => { setConfirmation({ operation: "delete", deviation: row }); setChangeReason(""); setActionError(null); }} />)}</div>}
    <PersonalDeviationForm key={`${ownerId}-${editing?.deviationId ?? "new"}`} open={formOpen} onOpenChange={setFormOpen}
      ownerId={ownerId} timezone={timezone!} practices={practices} editing={editing} onSubmit={submitForm}
      onReloadAfterUncertainCreate={reloadSavedBreaks} />
    <AlertDialog open={!!confirmation} onOpenChange={open => { if (!open && !actionSaving) setConfirmation(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmation?.operation === "delete" ? "Delete this personal break?" : "End this personal break now?"}</AlertDialogTitle>
          <AlertDialogDescription>{confirmation?.operation === "delete" ?
            "The break will be soft-deleted. Its saved history and audit record remain protected." :
            "The break will be marked ended at the current time. Its selected practices and history remain saved."}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="personal-break-action-reason">Why are you making this change?</Label>
          <Textarea id="personal-break-action-reason" value={changeReason} onChange={event => setChangeReason(event.target.value)}
            maxLength={500} required disabled={actionSaving} data-testid="input-personal-break-action-reason" />
          <p className="text-xs text-muted-foreground">This explanation is saved separately in the audit history.</p>
          {actionError && <p role="alert">{actionError}</p>}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={actionSaving}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={actionSaving || !changeReason.trim()} onClick={event => void runLifecycle(event, confirmation?.operation ?? "end")}>
            {actionSaving ? "Saving…" : confirmation?.operation === "delete" ? "Delete break" : "End break"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}
