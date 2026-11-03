import { describe, expect, it } from 'vitest';
import { colorIdsForTasks, EVENT_COLOR_PALETTE, NEUTRAL_COLOR_ID } from './colors';

const course = (id: string, externalRef?: string) => ({ id, type: 'course', externalRef });

describe('colorIdsForTasks', () => {
  it('uses ten colours that exclude graphite, each once', () => {
    const sorted = [...EVENT_COLOR_PALETTE].sort((a, b) => Number(a) - Number(b));
    expect(sorted).toEqual(['1', '2', '3', '4', '5', '6', '7', '9', '10', '11']);
  });

  it('gives tasks that share an externalRef one colour, and other courses their own', () => {
    const m = colorIdsForTasks([
      course('pm1', 'google-pm'),
      course('x'),
      course('pm2', 'google-pm'),
      course('pm3', 'google-pm'),
      { id: 'exam', type: 'cert_exam' },
    ]);
    expect(m.get('pm1')).toBe(m.get('pm2'));
    expect(m.get('pm1')).toBe(m.get('pm3'));
    expect(m.get('x')).not.toBe(m.get('pm1'));
    expect(m.get('exam')).not.toBe(m.get('x'));
    expect(m.get('pm1')).toBe(EVENT_COLOR_PALETTE[0]);
    expect(m.get('x')).toBe(EVENT_COLOR_PALETTE[1]);
    expect(m.get('exam')).toBe(EVENT_COLOR_PALETTE[2]);
  });

  it('gives practice, admin and CV tasks graphite and does not use up a group colour', () => {
    const m = colorIdsForTasks([
      { id: 'p', type: 'practice' },
      { id: 'a', type: 'admin', externalRef: 'r' },
      { id: 'cv', type: 'cv_update' },
      course('c1'),
    ]);
    for (const id of ['p', 'a', 'cv']) expect(m.get(id)).toBe(NEUTRAL_COLOR_ID);
    expect(m.get('c1')).toBe(EVENT_COLOR_PALETTE[0]);
  });

  it('never gives consecutive groups the same colour, and wraps after ten', () => {
    const tasks = Array.from({ length: 25 }, (_, i) => course(`t${i}`));
    const m = colorIdsForTasks(tasks);
    for (let i = 0; i < 24; i += 1) expect(m.get(`t${i}`)).not.toBe(m.get(`t${i + 1}`));
    expect(m.get('t10')).toBe(m.get('t0'));
    expect(new Set(tasks.slice(0, 10).map((t) => m.get(t.id))).size).toBe(10);
  });

  it('depends only on plan order, so it is stable', () => {
    const tasks = [course('a'), course('b', 'r'), course('c', 'r'), course('d')];
    expect(colorIdsForTasks(tasks)).toEqual(colorIdsForTasks(tasks));
  });
});
