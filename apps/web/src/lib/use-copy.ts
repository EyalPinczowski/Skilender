import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export type CopyState = 'idle' | 'copied' | 'failed';

/** Selects the text so it can be copied by hand, and tries the old copy command as a fallback. */
function copyWithSelection(node: HTMLElement | null): boolean {
  if (!node) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.addRange(range);
  try {
    return typeof document.execCommand === 'function' && document.execCommand('copy');
  } catch {
    return false;
  }
}

const RESET_MS = 4000;
/** A repeat copy blanks the message for a moment, so a screen reader announces it again once. */
const REANNOUNCE_MS = 150;

/**
 * Copies `text` with the clipboard API; when it is missing or refused, selects the text in `source`
 * for a manual copy. The state drives one persistent live region: "copied" is set once per copy and
 * cleared after a few seconds, so it is announced once and never repeats on its own.
 */
export function useCopyText(text: string, source: RefObject<HTMLElement | null>) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const again = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef<CopyState>('idle');
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      clearTimeout(again.current);
    },
    [],
  );

  const set = useCallback((next: CopyState) => {
    current.current = next;
    setState(next);
  }, []);

  const copy = useCallback(async (): Promise<boolean> => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) ok = copyWithSelection(source.current);
    clearTimeout(timer.current);
    clearTimeout(again.current);
    const done = () => {
      set(ok ? 'copied' : 'failed');
      if (ok) timer.current = setTimeout(() => set('idle'), RESET_MS);
    };
    if (ok && current.current === 'copied') {
      set('idle');
      again.current = setTimeout(done, REANNOUNCE_MS);
    } else {
      done();
    }
    return ok;
  }, [text, source, set]);

  return { state, copy };
}
