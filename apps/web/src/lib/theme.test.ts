import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, readTheme, saveTheme } from './theme';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('theme', () => {
  it('defaults to following the device', () => {
    expect(readTheme()).toBe('system');
  });

  it('round-trips a manual choice and forgets it when set back to the device', () => {
    saveTheme('dark');
    expect(readTheme()).toBe('dark');
    saveTheme('system');
    expect(readTheme()).toBe('system');
  });

  it('moves a theme saved under the old product name to the new key once', () => {
    window.localStorage.setItem('skillstack.theme', 'dark');
    expect(readTheme()).toBe('dark');
    expect(window.localStorage.getItem('upversion.theme')).toBe('dark');
    expect(window.localStorage.getItem('skillstack.theme')).toBeNull();
  });

  it('moves a theme saved under the Skilender name to the new key once', () => {
    window.localStorage.setItem('skilender.theme', 'light');
    expect(readTheme()).toBe('light');
    expect(window.localStorage.getItem('upversion.theme')).toBe('light');
    expect(window.localStorage.getItem('skilender.theme')).toBeNull();
  });

  it('prefers the Skilender key over the Skillstack one when both exist', () => {
    window.localStorage.setItem('skilender.theme', 'light');
    window.localStorage.setItem('skillstack.theme', 'dark');
    expect(readTheme()).toBe('light');
    expect(window.localStorage.getItem('skillstack.theme')).toBeNull();
  });

  it('prefers the new key over the old one and drops an invalid old value', () => {
    window.localStorage.setItem('upversion.theme', 'light');
    window.localStorage.setItem('skillstack.theme', 'dark');
    expect(readTheme()).toBe('light');
    window.localStorage.clear();
    window.localStorage.setItem('skillstack.theme', 'neon');
    expect(readTheme()).toBe('system');
    expect(window.localStorage.getItem('skillstack.theme')).toBeNull();
  });

  it('does not bring the old value back after the user picks the device default', () => {
    window.localStorage.setItem('skillstack.theme', 'dark');
    saveTheme('system');
    expect(readTheme()).toBe('system');
  });

  it('ignores an unknown stored value', () => {
    window.localStorage.setItem('upversion.theme', 'neon');
    expect(readTheme()).toBe('system');
  });

  it('sets data-theme for a manual choice and removes it for the device default', () => {
    applyTheme('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    applyTheme('light');
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    applyTheme('system');
    expect(document.documentElement).not.toHaveAttribute('data-theme');
  });

  it('still works when browser storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(readTheme()).toBe('system');
    expect(() => saveTheme('dark')).not.toThrow();
  });
});
