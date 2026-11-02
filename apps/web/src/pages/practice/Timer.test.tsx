import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { clock, FIVE_MINUTES_LEFT, TIME_IS_UP } from './practice-utils';
import { Timer } from './Timer';

const START = new Date('2026-11-10T09:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
  });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

const tick = (seconds: number) =>
  act(() => {
    vi.advanceTimersByTime(seconds * 1000);
  });

/** The texts the polite status region has been given, in order (one entry per change). */
function recordAnnouncements() {
  const region = screen.getByRole('status');
  const log: string[] = [];
  const observer = new MutationObserver(() => {});
  observer.observe(region, { childList: true, characterData: true, subtree: true });
  const seen = () => {
    if (observer.takeRecords().length > 0 && region.textContent) log.push(region.textContent);
    return log;
  };
  return { seen, stop: () => observer.disconnect() };
}

describe('clock', () => {
  it('formats minutes and hours', () => {
    expect(clock(65)).toBe('01:05');
    expect(clock(3725)).toBe('1:02:05');
    expect(clock(-90)).toBe('01:30');
  });
});

describe('Timer', () => {
  it('counts down from the planned minutes', () => {
    render(<Timer startedAt={START.toISOString()} plannedMinutes={30} />);
    expect(screen.getByRole('timer')).toHaveTextContent('30:00');
    tick(61);
    expect(screen.getByRole('timer')).toHaveTextContent('28:59');
    expect(screen.getByText('Time left')).toBeInTheDocument();
  });

  it('keeps going past zero and says "over time" in words', () => {
    render(<Timer startedAt={START.toISOString()} plannedMinutes={1} />);
    tick(60 + 125);
    expect(screen.getByRole('timer')).toHaveTextContent('+02:05');
    expect(screen.getByText('Over time')).toBeInTheDocument();
  });

  it('announces exactly twice: at 5 minutes left and at the end', () => {
    render(<Timer startedAt={START.toISOString()} plannedMinutes={10} />);
    const { seen, stop } = recordAnnouncements();
    expect(screen.getByRole('status')).toHaveTextContent('');

    tick(4 * 60 + 59); // 5:01 left
    expect(seen()).toEqual([]);
    tick(1); // 5:00 left
    expect(seen()).toEqual([FIVE_MINUTES_LEFT]);

    tick(4 * 60); // 1:00 left, one tick every second changed the clock but not the region
    expect(seen()).toEqual([FIVE_MINUTES_LEFT]);
    tick(59);
    expect(seen()).toEqual([FIVE_MINUTES_LEFT]);
    tick(1); // 0:00
    expect(seen()).toEqual([FIVE_MINUTES_LEFT, TIME_IS_UP]);

    tick(10 * 60); // ten more minutes over time: silence
    expect(seen()).toEqual([FIVE_MINUTES_LEFT, TIME_IS_UP]);
    stop();
  });

  it('keeps the ticking clock out of any live region', () => {
    render(<Timer startedAt={START.toISOString()} plannedMinutes={10} />);
    const timer = screen.getByRole('timer');
    expect(timer.closest('[aria-live]')).toBeNull();
    expect(timer).not.toHaveAttribute('aria-live', 'polite');
    expect(timer).not.toHaveAttribute('aria-live', 'assertive');
  });

  it('does not announce moments that were already passed when the page opened', () => {
    vi.setSystemTime(new Date(START.getTime() + 8 * 60_000)); // 2 minutes left on a 10 minute plan
    render(<Timer startedAt={START.toISOString()} plannedMinutes={10} />);
    const { seen, stop } = recordAnnouncements();
    tick(30);
    expect(seen()).toEqual([]);
    tick(120);
    expect(seen()).toEqual([TIME_IS_UP]);
    stop();
  });

  it('is silent when a resumed session is already over time', () => {
    vi.setSystemTime(new Date(START.getTime() + 20 * 60_000));
    render(<Timer startedAt={START.toISOString()} plannedMinutes={10} />);
    const { seen, stop } = recordAnnouncements();
    tick(120);
    expect(seen()).toEqual([]);
    expect(screen.getByRole('timer')).toHaveTextContent('+12:00');
    stop();
  });

  it('announces only the end when a sleeping tab jumps past both moments', () => {
    render(<Timer startedAt={START.toISOString()} plannedMinutes={10} />);
    const { seen, stop } = recordAnnouncements();
    act(() => {
      vi.setSystemTime(new Date(START.getTime() + 11 * 60_000));
      vi.advanceTimersByTime(1000);
    });
    expect(seen()).toEqual([TIME_IS_UP]);
    stop();
  });

  it('never shows more than the planned time when the browser clock is behind the server', () => {
    vi.setSystemTime(new Date(START.getTime() - 5 * 60_000)); // five minutes behind
    render(<Timer startedAt={START.toISOString()} plannedMinutes={30} />);
    expect(screen.getByRole('timer')).toHaveTextContent('30:00');
    tick(60); // still behind the start
    expect(screen.getByRole('timer')).toHaveTextContent('30:00');
    expect(screen.queryByText('Over time')).toBeNull();
  });

  it('has no accessibility violations', async () => {
    vi.useRealTimers();
    const { container } = render(
      <Timer startedAt={new Date().toISOString()} plannedMinutes={30} />,
    );
    await expectNoAxeViolations(container);
  });
});
