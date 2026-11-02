import { useId, useState, type FormEvent } from 'react';
import { Button, ErrorText, TextField } from '../../components/ui';
import type { FinishChoice } from './FinishDialog';

type Mode = 'steps' | 'score';

/**
 * Finishing without a model: tick the steps you completed, or enter a score you got elsewhere (for
 * example a timed test). The API turns either into the 0 to 10 score; nothing is computed here.
 */
export function RubricPanel({
  steps,
  onFinish,
  disabled = false,
}: {
  steps: readonly string[];
  onFinish: (choice: FinishChoice) => void;
  disabled?: boolean;
}) {
  const modeName = useId();
  const [mode, setMode] = useState<Mode>('steps');
  const [checked, setChecked] = useState<boolean[]>(() => steps.map(() => false));
  const [score, setScore] = useState('');
  const [max, setMax] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === 'steps') {
      setError(null);
      const checkedSteps = checked.flatMap((on, index) => (on ? [index] : []));
      onFinish({ kind: 'rubric', checkedSteps, total: steps.length });
      return;
    }
    const s = Number(score.replace(',', '.'));
    const m = Number(max.replace(',', '.'));
    if (score.trim() === '' || max.trim() === '' || !Number.isFinite(s) || !Number.isFinite(m)) {
      setError('Enter your score and the maximum score as numbers.');
      return;
    }
    if (m <= 0 || s < 0 || s > m) {
      setError('The maximum must be above 0, and your score between 0 and the maximum.');
      return;
    }
    setError(null);
    onFinish({ kind: 'score', score: s, max: m });
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby="rubric-heading" className="space-y-3">
      <h2 id="rubric-heading">Score yourself</h2>
      <p className="text-muted">No assistant needed. Choose how you want to rate this practice.</p>

      <fieldset className="space-y-2">
        <legend className="font-bold">Rate it by</legend>
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="radio"
            name={modeName}
            checked={mode === 'steps'}
            onChange={() => setMode('steps')}
            className="size-6"
          />
          Ticking off steps
        </label>
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="radio"
            name={modeName}
            checked={mode === 'score'}
            onChange={() => setMode('score')}
            className="size-6"
          />
          Entering a score I got elsewhere
        </label>
      </fieldset>

      {mode === 'steps' ? (
        <fieldset className="space-y-1">
          <legend className="font-bold">Steps I completed</legend>
          {steps.map((step, index) => (
            <label key={index} className="flex min-h-11 items-start gap-3 py-1">
              <input
                type="checkbox"
                checked={checked[index] ?? false}
                disabled={disabled}
                onChange={(event) =>
                  setChecked((old) => old.map((on, i) => (i === index ? event.target.checked : on)))
                }
                className="mt-0.5 size-6"
              />
              <span>{step}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="My score"
            inputMode="decimal"
            autoComplete="off"
            value={score}
            disabled={disabled}
            onChange={(event) => setScore(event.target.value)}
          />
          <TextField
            label="Maximum score"
            inputMode="decimal"
            autoComplete="off"
            value={max}
            disabled={disabled}
            onChange={(event) => setMax(event.target.value)}
          />
        </div>
      )}

      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button type="submit" variant="primary" disabled={disabled}>
        Finish with this self-check
      </Button>
    </form>
  );
}
