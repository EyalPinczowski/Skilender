import { usePracticeHistory } from '../../api/practice-hooks';
import { kindLabel, scoreText, sourceLabel } from './practice-labels';

/** Practice finished on one day, read-only, for the end-of-day review. */
export function DayPractice({
  planId,
  date,
  titleOf,
}: {
  planId: string;
  date: string;
  titleOf: (taskId: string) => string;
}) {
  const query = usePracticeHistory(planId, { from: date, to: date });
  return (
    <section aria-labelledby="todays-practice-heading" className="space-y-3">
      <h2 id="todays-practice-heading">Practice on this day</h2>
      {query.data ? (
        query.data.sessions.length === 0 ? (
          <p className="text-muted">No practice on this day.</p>
        ) : (
          <ul className="space-y-3">
            {query.data.sessions.map((s) => (
              <li key={s.id} className="space-y-1 rounded-md border border-border bg-surface p-4">
                <h3 className="text-lg font-bold">{titleOf(s.taskId)}</h3>
                <p className="text-muted">
                  {kindLabel(s.kind)} · {s.minutes} min · {sourceLabel(s.source)}
                </p>
                <p className="font-bold tabular-nums">
                  {s.score === null ? 'No score' : `Score ${scoreText(s.score)} of 10`}
                </p>
              </li>
            ))}
          </ul>
        )
      ) : query.isError ? (
        <p className="text-muted">Practice results could not be loaded.</p>
      ) : (
        <p className="text-muted">Loading practice results…</p>
      )}
    </section>
  );
}
