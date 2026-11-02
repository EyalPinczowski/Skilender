import { useRef } from 'react';
import type { PracticePrompt } from '../../api/practice-hooks';
import { Button, linkClass } from '../../components/ui';
import { useCopyText } from '../../lib/use-copy';

/** The new-chat page of claude.ai. A prefill URL parameter is "needs check" and is not used. */
export const CLAUDE_NEW_CHAT_URL = 'https://claude.ai/new';

function InputsSummary({ inputs }: { inputs: PracticePrompt['inputs'] }) {
  const items: string[] = [];
  if (inputs.nextFocus) items.push(`Your last focus point: ${inputs.nextFocus}`);
  if (inputs.topics.length > 0) items.push(`Topics from this week: ${inputs.topics.join(', ')}`);
  items.push(
    inputs.jobDescriptionIncluded
      ? 'Your job description is included.'
      : 'No job description is included.',
  );
  if (inputs.redactions > 0) {
    items.push(
      `${inputs.redactions} personal ${inputs.redactions === 1 ? 'detail was' : 'details were'} removed.`,
    );
  }
  return (
    <ul className="list-disc space-y-1 pl-6 text-muted">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

/**
 * The ready-made prompt for another assistant. "Copy prompt" copies it. "Open in Claude" copies it,
 * then opens claude.ai in a new tab; it is a real link so the browser opens the tab from the click.
 */
export function PromptPanel({ prompt }: { prompt: PracticePrompt }) {
  const preRef = useRef<HTMLPreElement>(null);
  const { state, copy } = useCopyText(prompt.prompt, preRef);

  return (
    <section aria-labelledby="prompt-heading" className="space-y-3">
      <h2 id="prompt-heading">Prompt</h2>
      <p className="text-muted">
        Paste this into Claude or another assistant. Role it plays: {prompt.persona.label}. It ends
        by asking for a feedback block; paste that block back below.
      </p>
      <InputsSummary inputs={prompt.inputs} />
      <pre
        ref={preRef}
        tabIndex={0}
        aria-label="Practice prompt"
        className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface-2 p-3 font-mono text-sm"
      >
        {prompt.prompt}
      </pre>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void copy()}>Copy prompt</Button>
        <a
          href={CLAUDE_NEW_CHAT_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => void copy()}
          className={`${linkClass} inline-flex min-h-11 items-center`}
        >
          Open in Claude
          <span className="sr-only"> (copies the prompt, then opens in a new tab)</span>
        </a>
        <span role="status" aria-live="polite" aria-atomic="true" className="font-bold text-ok">
          {state === 'copied' ? 'Copied' : ''}
        </span>
        {state === 'failed' ? (
          <span role="alert" className="font-bold text-warn">
            Couldn’t copy automatically. The text is selected: copy it by hand.
          </span>
        ) : null}
      </div>
    </section>
  );
}
