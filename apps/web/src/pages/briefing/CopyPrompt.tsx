import { useRef } from 'react';
import { Button } from '../../components/ui';
import { useCopyText } from '../../lib/use-copy';

/**
 * A ready-made prompt with a Copy button. Uses the clipboard API; when it is missing or refused the
 * text is selected for a manual copy and the message says so. The result is announced politely,
 * once per copy, from one live region that is always in the page.
 */
export function CopyPrompt({ text, label }: { text: string; label: string }) {
  const preRef = useRef<HTMLPreElement>(null);
  const { state, copy } = useCopyText(text, preRef);

  return (
    <div className="space-y-2">
      <pre
        ref={preRef}
        tabIndex={0}
        aria-label={label}
        className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface-2 p-3 font-mono text-sm"
      >
        {text}
      </pre>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void copy()}>
          Copy prompt<span className="sr-only">: {label}</span>
        </Button>
        <span role="status" aria-live="polite" aria-atomic="true" className="font-bold text-ok">
          {state === 'copied' ? 'Copied' : ''}
        </span>
        {state === 'failed' ? (
          <span role="alert" className="font-bold text-warn">
            Couldn’t copy automatically. The text is selected: copy it by hand.
          </span>
        ) : null}
      </div>
    </div>
  );
}
