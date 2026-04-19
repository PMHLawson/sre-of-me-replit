import { useEffect, useState } from 'react';
import { format, parseISO } from 'date-fns';
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
import type { Session } from '@/store';

interface SessionDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Session targeted for deletion; used to render a recognisable summary. */
  session: Session | null;
  /** Called when the user confirms the second step. Returns true on success. */
  onConfirm: (id: string) => Promise<boolean>;
}

/**
 * Two-step soft-delete confirmation. Step 1 explains what will happen and
 * surfaces a clear "Continue" action; step 2 requires the user to confirm
 * irreversibly (within the retention window — the row is recoverable from
 * Recently Deleted, but the user must opt in twice to remove it from sight).
 */
export function SessionDeleteDialog({ open, onOpenChange, session, onConfirm }: SessionDeleteDialogProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setStep(1);
  }, [open]);

  if (!session) return null;

  const summary = `${session.domain.replace('-', ' ')} · ${session.durationMinutes}m · ${format(parseISO(session.timestamp), 'MMM d, yyyy h:mm a')}`;

  const handleContinue = () => setStep(2);

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      const ok = await onConfirm(session.id);
      if (ok) {
        onOpenChange(false);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="dialog-session-delete">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {step === 1 ? 'Delete this session?' : 'Confirm deletion'}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                {step === 1
                  ? 'The session will be moved to Recently Deleted and can be restored within the retention window.'
                  : 'Final confirmation — the session will leave the active list now.'}
              </p>
              <p
                className="text-foreground font-mono text-xs bg-muted/50 px-3 py-2 rounded-lg capitalize"
                data-testid="text-session-delete-summary"
              >
                {summary}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={submitting}
            data-testid="button-session-delete-cancel"
          >
            Cancel
          </AlertDialogCancel>
          {step === 1 ? (
            <AlertDialogAction
              onClick={(e) => {
                // Prevent the AlertDialog from closing on the first-step click.
                e.preventDefault();
                handleContinue();
              }}
              data-testid="button-session-delete-continue"
            >
              Continue
            </AlertDialogAction>
          ) : (
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleConfirm();
              }}
              disabled={submitting}
              className="bg-status-critical hover:bg-status-critical/90"
              data-testid="button-session-delete-confirm"
            >
              {submitting ? 'Deleting…' : 'Delete session'}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
