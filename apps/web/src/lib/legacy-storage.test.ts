import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateLegacyStorage } from './legacy-storage';

const SESSION = '3f2b8c1e-5a4d-4e6f-9a1b-2c3d4e5f6a7b';

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('migrateLegacyStorage', () => {
  it('copies theme, plan and practice keys to the new names and removes the old ones', () => {
    const ls = window.localStorage;
    ls.setItem('skillstack.theme', 'dark');
    ls.setItem('skillstack.plan', 'plan-1');
    ls.setItem(`skillstack.practice.plan-1.task-1`, SESSION);
    ls.setItem(`skillstack.practice.plan-1.task-2`, SESSION);

    migrateLegacyStorage();

    expect(ls.getItem('upversion.theme')).toBe('dark');
    expect(ls.getItem('upversion.plan')).toBe('plan-1');
    expect(ls.getItem('upversion.practice.plan-1.task-1')).toBe(SESSION);
    expect(ls.getItem('upversion.practice.plan-1.task-2')).toBe(SESSION);
    expect(ls.getItem('skillstack.theme')).toBeNull();
    expect(ls.getItem('skillstack.plan')).toBeNull();
    expect(ls.getItem('skillstack.practice.plan-1.task-1')).toBeNull();
    expect(ls.getItem('skillstack.practice.plan-1.task-2')).toBeNull();
  });

  it('does not overwrite an existing new key, but still removes the old one', () => {
    const ls = window.localStorage;
    ls.setItem('skillstack.theme', 'dark');
    ls.setItem('upversion.theme', 'light');

    migrateLegacyStorage();

    expect(ls.getItem('upversion.theme')).toBe('light');
    expect(ls.getItem('skillstack.theme')).toBeNull();
  });

  it('leaves unrelated keys alone and is idempotent', () => {
    const ls = window.localStorage;
    ls.setItem('other.key', 'x');
    ls.setItem('skillstack.theme', 'dark');

    migrateLegacyStorage();
    migrateLegacyStorage();

    expect(ls.getItem('other.key')).toBe('x');
    expect(ls.getItem('upversion.theme')).toBe('dark');
    expect(ls.length).toBe(2);
  });

  it('does nothing when there is nothing to migrate', () => {
    migrateLegacyStorage();
    expect(window.localStorage.length).toBe(0);
  });

  it('survives storage that throws on access', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => migrateLegacyStorage()).not.toThrow();
  });

  it('survives storage that throws on read, write and remove', () => {
    window.localStorage.setItem('skillstack.theme', 'dark');
    window.localStorage.setItem('skillstack.plan', 'plan-1');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => migrateLegacyStorage()).not.toThrow();
    vi.restoreAllMocks();
    // Nothing was lost: the old values are still there for the next start.
    expect(window.localStorage.getItem('skillstack.theme')).toBe('dark');
    expect(window.localStorage.getItem('skillstack.plan')).toBe('plan-1');
  });
});
