import { useEffect, useRef } from 'react';
import type { PracticeFeedback } from '../../api/practice-hooks';
import { CheckIcon } from '../../components/icons';
import { linkClass } from '../../components/ui';
import { formatHours } from '../../lib/format';
import type { TaskStatus } from '../../lib/task-types';

const SOURCE_LABEL: Record<PracticeFeedback['source'], string> = {
  model_json: 'AI feedback',
  model_repaired: 'AI feedback',
  pasted_block: 'Pasted feedback',
  free_text: 'Pasted text, saved as it was',
  self_rubric: 'Your self-check',
};

export interface FinishedExtras {
  loggedHours: number | null;
  taskStatus: TaskStatus;
  /** False when the pasted text had no readable feedback block. */
  parsed?: boolean;
  replayed?: boolean;
}

function Part({ title, text }: { title: string; text: string }) {
  if (text.trim() === '') return null;
  return (
    <div className="space-y-1">
      <h3 className="font-bold">{title}</h3>
      <p className="whitespace-pre-wrap break-words">{text}</p>
    </div>
  );
}

/**
 * What was saved. Score, strengths, improvements and the next focus are the API's own answer,
 * shown as plain text. The task is "done" only if the person ticked that box in the dialog.
 */
export function FinishedSummary({
  feedback,
  extras,
  onAgain,
}: {
  feedback: PracticeFeedback | null;
  extras?: FinishedExtras;
  onAgain: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // The dialog is gone: put focus on the result so a keyboard or screen reader user lands on it.
  useEffect(() => heading.current?.focus(), []);
  const plainText = feedback?.source === 'free_text';
  return (
    <section aria-labelledby="finished-heading" className="space-y-4">
      <h2 id="finished-heading" ref={heading} tabIndex={-1} className="flex items-center gap-2">
        <span className="text-ok">
          <CheckIcon />
        </span>
        Practice finished
      </h2>

      {feedback ? (
        <div className="space-y-3">
          <p className="text-muted">{SOURCE_LABEL[feedback.source]}</p>
          {feedback.score !== null ? (
            <p className="text-h2 font-bold tabular-nums">Score: {feedback.score} out of 10</p>
          ) : (
            <p className="font-bold">No score: this feedback had no number.</p>
          )}
          {plainText || extras?.parsed === false ? (
            <p className="text-muted">
              No feedback block was found, so the text is saved as plain text.
            </p>
          ) : null}
          {plainText ? (
            <Part title="Your pasted text" text={feedback.raw ?? ''} />
          ) : (
            <>
              <Part title="Strengths" text={feedback.strengths} />
              <Part title="To improve" text={feedback.improve} />
              <Part title="Next focus" text={feedback.nextFocus} />
            </>
          )}
        </div>
      ) : (
        <p>No feedback was saved for this practice.</p>
      )}

      {extras ? (
        <ul className="space-y-1">
          <li>
            {extras.loggedHours !== null
              ? `Logged ${formatHours(extras.loggedHours)}.`
              : 'No time was logged.'}
          </li>
          <li>
            {extras.taskStatus === 'done'
              ? 'The task is marked done.'
              : 'The task was not marked done.'}
          </li>
          {extras.replayed ? <li className="text-muted">This was already saved before.</li> : null}
        </ul>
      ) : null}

      <p className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={onAgain}
          className={`${linkClass} inline-flex min-h-11 items-center`}
        >
          Practise again
        </button>
      </p>
    </section>
  );
}
