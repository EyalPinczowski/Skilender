import { describe, expect, it } from 'vitest';
import { APP_NAME, APP_TAGLINE } from './index';

describe('shared package', () => {
  it('exposes the product name and tagline used across the app', () => {
    expect(APP_NAME).toBe('Upversion');
    expect(APP_TAGLINE).toBe('A study plan that improves with you');
  });
});
