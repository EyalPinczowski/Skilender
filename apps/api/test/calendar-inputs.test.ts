import { describe, expect, it } from 'vitest';
import { calendarInputsFromRows, withDayOffs } from '../src/modules/calendar/inputs';

const TZ = 'Asia/Jerusalem';
const row = (
  kind: 'busy' | 'tentative' | 'all_day',
  date: string,
  s = 0,
  e = 1440,
  blocks_day = false,
) => ({ date, start_minute: s, end_minute: e, kind, blocks_day });

describe('calendarInputsFromRows', () => {
  it('counts busy rows only and turns blocking all-day rows into day-offs', () => {
    const r = calendarInputsFromRows(
      [
        row('busy', '2026-11-02', 660, 780),
        row('tentative', '2026-11-02', 900, 960),
        row('all_day', '2026-11-03'),
        row('all_day', '2026-11-04', 0, 1440, true),
      ],
      [],
      TZ,
    );
    expect(r.busy).toEqual([{ date: '2026-11-02', start: '11:00', end: '13:00' }]);
    expect(r.dayOffs).toEqual(['2026-11-04']);
    expect(r.lockedBlocks).toEqual([]);
  });

  it('maps moved rows to locked blocks and deleted rows to busy time', () => {
    const r = calendarInputsFromRows(
      [],
      [
        {
          reason: 'moved',
          task_id: 't',
          starts_at: new Date('2026-11-02T13:00:00Z'),
          ends_at: new Date('2026-11-02T14:00:00Z'),
        },
        {
          reason: 'deleted',
          task_id: 't',
          starts_at: new Date('2026-11-03T07:00:00Z'),
          ends_at: new Date('2026-11-03T08:30:00Z'),
        },
      ],
      TZ,
    );
    expect(r.lockedBlocks).toEqual([
      {
        taskId: 't',
        date: '2026-11-02',
        start: '15:00',
        end: '16:00',
        minutes: 60,
        kind: 'locked',
      },
    ]);
    expect(r.busy).toEqual([{ date: '2026-11-03', start: '09:00', end: '10:30' }]);
  });

  it('is empty for no rows', () => {
    expect(calendarInputsFromRows([], [], TZ)).toEqual({
      busy: [],
      dayOffs: [],
      lockedBlocks: [],
    });
  });
});

describe('withDayOffs', () => {
  it('returns the same overrides when there are no day-offs', () => {
    const o = [{ date: '2026-11-02', isStudyDay: true, capacityHours: 3 }];
    expect(withDayOffs(o, [])).toBe(o);
  });

  it('adds day-offs, replaces an override on the same date and keeps date order', () => {
    const o = [
      { date: '2026-11-05', isStudyDay: true, capacityHours: 3 },
      { date: '2026-11-03', isStudyDay: true, capacityHours: 2 },
    ];
    expect(withDayOffs(o, ['2026-11-01', '2026-11-03'])).toEqual([
      { date: '2026-11-01', isStudyDay: false },
      { date: '2026-11-03', isStudyDay: false },
      { date: '2026-11-05', isStudyDay: true, capacityHours: 3 },
    ]);
  });
});
