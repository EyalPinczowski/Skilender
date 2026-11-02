import { MAX_PASTED_FEEDBACK_LENGTH } from '@skillstack/shared';
import { useState, type FormEvent } from 'react';
import { Button, TextAreaField } from '../../components/ui';
import type { FinishChoice } from './FinishDialog';

/**
 * Where the reply of the other assistant is pasted back. A reply with the ===FEEDBACK=== block is
 * parsed by the API; any other text is saved as plain text, so a paste is never rejected for its
 * format. The draft stays in memory only.
 */
export function PasteFeedback({
  onFinish,
  disabled = false,
}: {
  onFinish: (choice: FinishChoice) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (text.trim() === '') {
      setError('Paste the reply first.');
      return;
    }
    setError(null);
    onFinish({ kind: 'paste', text });
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby="paste-heading" className="space-y-3">
      <h2 id="paste-heading">Paste the feedback</h2>
      <TextAreaField
        label="Reply from your assistant"
        hint="Paste the whole reply or only the block from ===FEEDBACK=== to ===END===. Text without a block is saved as plain text."
        value={text}
        rows={8}
        maxLength={MAX_PASTED_FEEDBACK_LENGTH}
        autoComplete="off"
        error={error}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
      />
      <Button type="submit" variant="primary" disabled={disabled}>
        Finish with this feedback
      </Button>
    </form>
  );
}
