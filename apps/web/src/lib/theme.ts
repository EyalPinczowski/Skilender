import { useCallback, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'upversion.theme';
/** Keys used under earlier product names (Skillstack, Skilender); read once, then moved to STORAGE_KEY. */
const LEGACY_STORAGE_KEYS = ['skilender.theme', 'skillstack.theme'];

export const isThemePreference = (value: unknown): value is ThemePreference =>
  value === 'system' || value === 'light' || value === 'dark';

/** Browser storage can be blocked (private windows) or throw: the theme then just isn't remembered. */
export function readTheme(): ThemePreference {
  try {
    let value = window.localStorage.getItem(STORAGE_KEY);
    if (value === null) {
      for (const key of LEGACY_STORAGE_KEYS) {
        const legacy = window.localStorage.getItem(key);
        if (legacy === null) continue;
        if (value === null && isThemePreference(legacy)) {
          value = legacy;
          window.localStorage.setItem(STORAGE_KEY, legacy);
        }
        window.localStorage.removeItem(key);
      }
    }
    return isThemePreference(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

/**
 * "system" removes the attribute so the tokens follow the device (prefers-color-scheme); light and
 * dark set `data-theme`, which the tokens treat as a manual override.
 */
export function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
}

export function saveTheme(preference: ThemePreference): void {
  try {
    for (const key of LEGACY_STORAGE_KEYS) window.localStorage.removeItem(key);
    if (preference === 'system') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Not remembered; the choice still applies for this visit.
  }
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readTheme);
  const choose = useCallback((next: ThemePreference) => {
    setPreference(next);
    applyTheme(next);
    saveTheme(next);
  }, []);
  return { preference, choose };
}
