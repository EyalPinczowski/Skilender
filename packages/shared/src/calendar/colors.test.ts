import { describe, expect, it } from 'vitest';
import { colorIdForTask, EVENT_COLOR_PALETTE } from './colors';

describe('colorIdForTask', () => {
  it('uses each of the 11 Google ids exactly once', () => {
    expect([...EVENT_COLOR_PALETTE].sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 11 }, (_, i) => String(i + 1)),
    );
  });

  it('is deterministic', () => {
    expect(colorIdForTask(3)).toBe(colorIdForTask(3));
    expect(colorIdForTask(0)).toBe(EVENT_COLOR_PALETTE[0]);
  });

  it('gives the first 11 tasks 11 different colours', () => {
    const ids = Array.from({ length: 11 }, (_, i) => colorIdForTask(i));
    expect(new Set(ids).size).toBe(11);
  });

  it('never gives neighbours the same colour, including across the wrap', () => {
    for (let i = 0; i < 60; i += 1) expect(colorIdForTask(i)).not.toBe(colorIdForTask(i + 1));
  });

  it('repeats every 11 tasks', () => {
    expect(colorIdForTask(11)).toBe(colorIdForTask(0));
    expect(colorIdForTask(35)).toBe(colorIdForTask(2));
  });

  it('copes with odd input', () => {
    expect(colorIdForTask(-1)).toBe(EVENT_COLOR_PALETTE[10]);
    expect(colorIdForTask(Number.NaN)).toBe(EVENT_COLOR_PALETTE[0]);
  });
});
