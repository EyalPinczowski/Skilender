import { MAX_JOB_DESCRIPTION_LENGTH } from '@upversion/shared';
import { useState, type FormEvent } from 'react';
import { useJobDescription, useSaveJobDescription } from '../../api/practice-hooks';
import { QueryView } from '../../components/QueryView';
import { Button, ErrorText, TextAreaField } from '../../components/ui';
import { describeError } from '../../lib/messages';

function Editor({ planId, stored }: { planId: string; stored: string }) {
  const save = useSaveJobDescription(planId);
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const value = draft ?? stored;
  const changed = value !== stored;

  function run(next: string) {
    setMessage(null);
    save.mutate(next, {
      onSuccess: (saved) => {
        setDraft(null);
        if (next === '') setMessage('Job description removed.');
        else if (saved.redactionsPreview > 0) {
          setMessage(
            `Saved. ${saved.redactionsPreview} personal ${saved.redactionsPreview === 1 ? 'detail' : 'details'} will be removed from prompts.`,
          );
        } else setMessage('Saved.');
      },
    });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    run(value.trim());
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-3">
      <TextAreaField
        label="Job description"
        hint="Optional. Paste the posting for your next interview and the practice prompt uses it. Emails, phone numbers and links are removed before any AI model could see it. It is saved to your account, not to this browser."
        value={value}
        rows={6}
        maxLength={MAX_JOB_DESCRIPTION_LENGTH}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setDraft(event.target.value);
          setMessage(null);
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={save.isPending || !changed}>
          {save.isPending ? 'Saving…' : 'Save job description'}
        </Button>
        {stored !== '' ? (
          <Button disabled={save.isPending} onClick={() => run('')}>
            Remove job description
          </Button>
        ) : null}
        <span role="status" aria-live="polite" className="font-bold text-ok">
          {message}
        </span>
      </div>
      {save.isError ? (
        <ErrorText>
          {describeError(save.error, 'The job description could not be saved.')}
        </ErrorText>
      ) : null}
    </form>
  );
}

/** The job description of the next interview, used by every practice prompt of the plan. */
export function JobDescriptionField({ planId }: { planId: string }) {
  const query = useJobDescription(planId);
  return (
    <QueryView query={query} label="Loading the job description…">
      {(data) => <Editor planId={planId} stored={data.jobDescription} />}
    </QueryView>
  );
}
