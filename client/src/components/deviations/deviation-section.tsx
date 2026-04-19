import { useMemo, useState } from 'react';
import { Plus, CalendarOff, CalendarClock, Pencil, X, Trash2 } from 'lucide-react';
import { useAppStore, type Deviation, type Domain } from '@/store';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { DeviationForm } from './deviation-form';

const DOMAIN_LABEL: Record<Domain, string> = {
  'martial-arts': 'Martial Arts',
  meditation: 'Meditation',
  fitness: 'Fitness',
  music: 'Music',
};

function formatRange(startIso: string, endIso: string | null): string {
  const start = new Date(startIso);
  const fmt = (d: Date) =>
    d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  if (!endIso) return `${fmt(start)} → ongoing`;
  return `${fmt(start)} → ${fmt(new Date(endIso))}`;
}

interface DeviationRowProps {
  deviation: Deviation;
  variant: 'active' | 'planned';
  onEdit: (d: Deviation) => void;
  onEnd: (d: Deviation) => void;
  onDelete: (d: Deviation) => void;
}

function DeviationRow({ deviation, variant, onEdit, onEnd, onDelete }: DeviationRowProps) {
  const dom = deviation.domain as Domain;
  return (
    <div
      className="bg-card border border-border/50 rounded-2xl p-4 space-y-2 shadow-sm"
      data-testid={`row-deviation-${deviation.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              {DOMAIN_LABEL[dom] ?? deviation.domain}
            </span>
            {deviation.excludeFromComposite && (
              <span className="text-[10px] font-bold uppercase tracking-widest text-status-advisory bg-status-advisory/10 px-2 py-0.5 rounded-full">
                Excluded from composite
              </span>
            )}
            {variant === 'planned' && (
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                Planned
              </span>
            )}
          </div>
          <p
            className="text-sm font-medium text-foreground mt-1 break-words"
            data-testid={`text-deviation-reason-${deviation.id}`}
          >
            {deviation.reason}
          </p>
          <p className="text-xs text-muted-foreground mt-1 font-mono">
            {formatRange(deviation.startAt, deviation.endAt)}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onEdit(deviation)}
          data-testid={`button-edit-deviation-${deviation.id}`}
        >
          <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
        </Button>
        {variant === 'active' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onEnd(deviation)}
            data-testid={`button-end-deviation-${deviation.id}`}
          >
            <X className="w-3.5 h-3.5 mr-1" /> End now
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="text-status-critical hover:text-status-critical"
          onClick={() => onDelete(deviation)}
          data-testid={`button-delete-deviation-${deviation.id}`}
        >
          <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
        </Button>
      </div>
    </div>
  );
}

export function DeviationSection() {
  const deviations = useAppStore((s) => s.deviations);
  const deviationsLoaded = useAppStore((s) => s.deviationsLoaded);
  const createDeviation = useAppStore((s) => s.createDeviation);
  const updateDeviation = useAppStore((s) => s.updateDeviation);
  const endDeviation = useAppStore((s) => s.endDeviation);
  const deleteDeviation = useAppStore((s) => s.deleteDeviation);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Deviation | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Deviation | null>(null);
  const [confirmEnd, setConfirmEnd] = useState<Deviation | null>(null);

  const { active, planned } = useMemo(() => {
    const now = new Date();
    const a: Deviation[] = [];
    const p: Deviation[] = [];
    for (const d of deviations) {
      if (d.endedAt) continue;
      const start = new Date(d.startAt);
      const end = d.endAt ? new Date(d.endAt) : null;
      if (start > now) {
        p.push(d);
      } else if (!end || end >= now) {
        a.push(d);
      }
    }
    return { active: a, planned: p };
  }, [deviations]);

  const handleOpenCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const handleOpenEdit = (d: Deviation) => {
    setEditing(d);
    setFormOpen(true);
  };

  const handleSubmit = async (draftOrPatch: any) => {
    if (editing) {
      return await updateDeviation(editing.id, draftOrPatch);
    }
    return await createDeviation(draftOrPatch);
  };

  return (
    <section className="space-y-3" data-testid="section-deviations">
      <div className="flex items-center justify-between px-2">
        <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-widest">
          Deviations
        </h2>
        <Button
          size="sm"
          onClick={handleOpenCreate}
          data-testid="button-declare-deviation"
        >
          <Plus className="w-4 h-4 mr-1" /> Declare
        </Button>
      </div>

      {!deviationsLoaded ? (
        <div
          className="bg-card border border-border/50 rounded-2xl p-4 text-sm text-muted-foreground"
          data-testid="status-deviations-loading"
        >
          Loading deviations…
        </div>
      ) : active.length === 0 && planned.length === 0 ? (
        <div
          className="bg-card border border-border/50 rounded-2xl p-4 text-sm text-muted-foreground flex items-start gap-3"
          data-testid="status-deviations-empty"
        >
          <CalendarOff className="w-4 h-4 mt-0.5 text-muted-foreground/70" />
          <div>
            <p className="font-medium text-foreground">No deviations declared</p>
            <p className="text-xs mt-0.5">
              Declare a deviation when a domain is intentionally off-target — travel,
              injury, or a planned focus shift. Active deviations can be excluded
              from the composite score and pause error-budget drawdown.
            </p>
          </div>
        </div>
      ) : (
        <>
          {active.length > 0 && (
            <div className="space-y-2">
              <div className="px-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-status-advisory">
                <CalendarOff className="w-3 h-3" />
                Active ({active.length})
              </div>
              {active.map((d) => (
                <DeviationRow
                  key={d.id}
                  deviation={d}
                  variant="active"
                  onEdit={handleOpenEdit}
                  onEnd={(dev) => setConfirmEnd(dev)}
                  onDelete={(dev) => setConfirmDelete(dev)}
                />
              ))}
            </div>
          )}
          {planned.length > 0 && (
            <div className="space-y-2">
              <div className="px-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                <CalendarClock className="w-3 h-3" />
                Planned ({planned.length})
              </div>
              {planned.map((d) => (
                <DeviationRow
                  key={d.id}
                  deviation={d}
                  variant="planned"
                  onEdit={handleOpenEdit}
                  onEnd={(dev) => setConfirmEnd(dev)}
                  onDelete={(dev) => setConfirmDelete(dev)}
                />
              ))}
            </div>
          )}
        </>
      )}

      <DeviationForm
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        onSubmit={handleSubmit}
      />

      <AlertDialog open={!!confirmEnd} onOpenChange={(o) => !o && setConfirmEnd(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End deviation now?</AlertDialogTitle>
            <AlertDialogDescription>
              The deviation will be marked ended at the current time. The
              affected domain will resume normal composite weighting and error
              budget drawdown immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-end-deviation-cancel">
              Keep active
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-end-deviation-confirm"
              onClick={async () => {
                if (confirmEnd) await endDeviation(confirmEnd.id);
                setConfirmEnd(null);
              }}
            >
              End now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this deviation?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the deviation from your dashboard. Historical scoring
              recomputes as if the deviation never existed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-delete-deviation-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-delete-deviation-confirm"
              onClick={async () => {
                if (confirmDelete) await deleteDeviation(confirmDelete.id);
                setConfirmDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
