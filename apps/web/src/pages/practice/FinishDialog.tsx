import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button, ErrorText } from '../../components/ui';
import { describeChoice } from './practice-utils';

/** What the session will be finished with. The panels build it; the dialog only shows it. */
export type FinishChoice =
  | { kind: 'none' }
  | { kind: 'rubric'; checkedSteps: number[]; total: number }
  | { kind: 'score'; score: number; max: number }
  | { kind: 'paste'; text: string };

export interface FinishDecision {
  /** The explicit "Mark task done" choice. False unless the person ticked it. */
  markDone: boolean;
  /** Hours to log, or null to log nothing. */
  logHours: number | null;
}

/** The API's upper limit for one session's log, shown as a hint; the API is the authority. */
const MAX_HOURS = 12;

const FOCUSABLE = 'input, button, textarea, select, [href], [tabindex]:not([tabindex="-1"])';

/**
 * The last step of a practice: how many hours to log, and whether to mark the task done. Marking
 * done is its own unticked checkbox: finishing with feedback never marks anything done. A modal
 * with a focus trap; Escape cancels and focus goes back to the button that opened it.
 */
export function FinishDialog({
  choice,
  defaultHours,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  choice: FinishChoice;
  /** Prefilled hours (the time spent, rounded). Empty or 0 logs nothing. */
  defaultHours: number | null;
  busy: boolean;
  error: string | null;
  onSubmit: (decision: FinishDecision) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const hoursId = useId();
  const hoursErrorId = useId();
  const doneId = useId();
  const doneHintId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const hoursRef = useRef<HTMLInputElement>(null);
  const [hours, setHours] = useState(defaultHours === null ? '' : String(defaultHours));
  const [markDone, setMarkDone] = useState(false);
  const [hoursError, setHoursError] = useState<string | null>(null);

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    hoursRef.current?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    ).filter((el) => !el.hasAttribute('disabled'));
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = hours.trim().replace(',', '.');
    let logHours: number | null = null;
    if (text !== '') {
      const value = Number(text);
      if (!Number.isFinite(value) || value < 0 || value > MAX_HOURS) {
        setHoursError(`Enter hours as a number from 0 to ${MAX_HOURS}, or leave it empty.`);
        hoursRef.current?.focus();
        return;
      }
      logHours = value === 0 ? null : value;
    }
    setHoursError(null);
    onSubmit({ markDone, logHours });
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-end justify-center p-4 sm:items-center"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.55)' }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="max-h-full w-full max-w-md overflow-auto rounded-md border border-border bg-surface p-5"
      >
        <form onSubmit={submit} noValidate className="space-y-4">
          <h2 id={titleId}>Finish this practice</h2>
          <p id={bodyId}>{describeChoice(choice)}</p>

          <div className="space-y-1">
            <label htmlFor={hoursId} className="block font-bold">
              Hours to log
            </label>
            <p className="text-muted">Leave empty to log no time.</p>
            <input
              ref={hoursRef}
              id={hoursId}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={hours}
              disabled={busy}
              aria-invalid={hoursError ? true : undefined}
              aria-describedby={hoursError ? hoursErrorId : undefined}
              onChange={(event) => setHours(event.target.value)}
              className="min-h-11 w-full rounded-sm border border-border bg-surface px-3 py-2 text-text"
            />
            {hoursError ? <ErrorText id={hoursErrorId}>{hoursError}</ErrorText> : null}
          </div>

          <div className="space-y-1">
            <div className="flex items-start gap-3">
              <input
                id={doneId}
                type="checkbox"
                checked={markDone}
                disabled={busy}
                aria-describedby={doneHintId}
                onChange={(event) => setMarkDone(event.target.checked)}
                className="mt-1 size-6"
              />
              <label htmlFor={doneId} className="font-bold">
                Mark task done
              </label>
            </div>
            <p id={doneHintId} className="pl-9 text-muted">
              Off by default. Your feedback and your time are saved either way; the task stays open
              unless you tick this.
            </p>
          </div>

          {error ? <ErrorText>{error}</ErrorText> : null}

          <div className="flex flex-wrap justify-end gap-3">
            <Button onClick={onCancel} disabled={busy}>
              Back
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Finish practice'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
