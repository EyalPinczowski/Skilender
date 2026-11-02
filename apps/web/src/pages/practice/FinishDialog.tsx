import { MAX_LOG_HOURS } from '@skillstack/shared';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button, ErrorText } from '../../components/ui';
import { describeChoice } from './practice-utils';

/** What the session will be finished with. The panels build it; the dialog only shows it. */
export type FinishChoice =
  | { kind: 'none' }
  | { kind: 'rubric'; checkedSteps: number[]; total: number }
  | { kind: 'score'; score: number; max: number }
  | { kind: 'paste'; text: string }
  | { kind: 'ai' };

export interface FinishDecision {
  /** The explicit "Mark task done" choice. False unless the person ticked it. */
  markDone: boolean;
  /** Hours to log, or null to log nothing. */
  logHours: number | null;
}

const FOCUSABLE = 'input, button, textarea, select, [href], [tabindex]:not([tabindex="-1"])';

/**
 * While the dialog is open everything else on the page is inert, so neither a screen reader nor
 * the keyboard can reach it. The dialog itself is portalled out of the inert part.
 */
function useInertBackground(dialog: HTMLElement | null) {
  useEffect(() => {
    if (!dialog) return;
    const host = dialog.closest('[data-modal-host]');
    const others = Array.from(document.body.children).filter(
      (el) => el !== host && !el.hasAttribute('inert'),
    );
    others.forEach((el) => el.setAttribute('inert', ''));
    return () => others.forEach((el) => el.removeAttribute('inert'));
  }, [dialog]);
}

/**
 * The last step of a practice: how many hours to log, and whether to mark the task done. Marking
 * done is its own unticked checkbox: finishing with feedback never marks anything done.
 *
 * Focus stays inside: while saving, the buttons are `aria-disabled` rather than `disabled`, so the
 * focused one keeps focus; when the save fails, focus moves to the error. Escape cancels and focus
 * goes back to the button that opened the dialog.
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
  /** Prefilled hours (the time spent, rounded). Null leaves the field empty: nothing is logged. */
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
  const [dialog, setDialog] = useState<HTMLDivElement | null>(null);
  const hoursRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const [hours, setHours] = useState(defaultHours === null ? '' : String(defaultHours));
  const [markDone, setMarkDone] = useState(false);
  const [hoursError, setHoursError] = useState<string | null>(null);

  useInertBackground(dialog);

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    hoursRef.current?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, []);

  // A failed save leaves the dialog open: say so where the person is, not somewhere behind it.
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (el) => !el.hasAttribute('disabled'),
    );
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
    if (busy) return;
    const text = hours.trim().replace(',', '.');
    let logHours: number | null = null;
    if (text !== '') {
      const value = Number(text);
      if (!Number.isFinite(value) || value < 0 || value > MAX_LOG_HOURS) {
        setHoursError(`Enter hours as a number from 0 to ${MAX_LOG_HOURS}, or leave it empty.`);
        hoursRef.current?.focus();
        return;
      }
      logHours = value === 0 ? null : value;
    }
    setHoursError(null);
    onSubmit({ markDone, logHours });
  }

  const busyClass = busy ? 'cursor-not-allowed opacity-60' : '';

  return createPortal(
    <div
      data-modal-host
      className="fixed inset-0 z-30 flex items-end justify-center p-4 sm:items-center"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.55)' }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={setDialog}
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
              readOnly={busy}
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
                aria-disabled={busy || undefined}
                aria-describedby={doneHintId}
                onChange={(event) => {
                  if (!busy) setMarkDone(event.target.checked);
                }}
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

          {error ? (
            <div ref={errorRef} tabIndex={-1}>
              <ErrorText>{error}</ErrorText>
            </div>
          ) : null}

          <div className="flex flex-wrap justify-end gap-3">
            <Button
              aria-disabled={busy || undefined}
              className={busyClass}
              onClick={() => {
                if (!busy) onCancel();
              }}
            >
              Back
            </Button>
            <Button
              type="submit"
              variant="primary"
              aria-disabled={busy || undefined}
              className={busyClass}
            >
              {busy ? 'Saving…' : 'Finish practice'}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
