import { Link } from 'react-router';
import { usePracticeTrends } from '../../api/practice-hooks';
import { linkClass } from '../../components/ui';
import { deltaText, kindLabel, scoreText } from './practice-labels';

/**
 * "Last practice score" per kind, for the Week screen. It is a side note: while loading, or when
 * the trends cannot be read, it says so quietly and never blocks the rest of the page.
 */
export function LastPracticeScores({ planId }: { planId: string }) {
  const query = usePracticeTrends(planId);
  return (
    <section aria-labelledby="last-practice-heading" className="space-y-2">
      <h2 id="last-practice-heading">Last practice score</h2>
      {query.data ? (
        query.data.kinds.length === 0 ? (
          <p className="text-muted">No practice scores yet.</p>
        ) : (
          <ul className="space-y-1">
            {query.data.kinds.map((k) => (
              <li key={k.kind} className="tabular-nums">
                <span className="font-bold">{kindLabel(k.kind)}:</span> {scoreText(k.last)} of 10 (
                {deltaText(k.delta)})
              </li>
            ))}
          </ul>
        )
      ) : query.isError ? (
        <p className="text-muted">Practice scores could not be loaded.</p>
      ) : (
        <p className="text-muted">Loading practice scores…</p>
      )}
      <p>
        <Link to="/practice-history" className={`${linkClass} inline-flex min-h-11 items-center`}>
          See practice scores over time
        </Link>
      </p>
    </section>
  );
}
