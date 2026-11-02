/**
 * One-time move of browser storage keys from the old product name to the new one, so a person's
 * theme, active plan and running practice sessions survive the rename. The old name is spelled
 * out on purpose: this file and its test are the only code that still reads those keys.
 */
const OLD_PREFIX = 'skillstack.';
const NEW_PREFIX = 'upversion.';

/**
 * Copies every `skillstack.*` localStorage entry to its `upversion.*` key (never overwriting a
 * value that already exists there), then removes the old key. Safe to run on every start: once
 * the old keys are gone it does nothing. Storage can throw (private mode, blocked site data), in
 * which case the app simply starts without the old values.
 */
export function migrateLegacyStorage(): void {
  let storage: Storage;
  let legacyKeys: string[];
  try {
    storage = window.localStorage;
    legacyKeys = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(OLD_PREFIX)) legacyKeys.push(key);
    }
  } catch {
    return;
  }

  for (const oldKey of legacyKeys) {
    // Per key, so one failing entry does not stop the others.
    try {
      const newKey = NEW_PREFIX + oldKey.slice(OLD_PREFIX.length);
      if (storage.getItem(newKey) === null) {
        const value = storage.getItem(oldKey);
        if (value !== null) storage.setItem(newKey, value);
      }
      storage.removeItem(oldKey);
    } catch {
      // Leave the old key in place; the next start tries again.
    }
  }
}
