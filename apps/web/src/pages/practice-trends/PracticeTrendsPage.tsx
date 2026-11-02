import { Link } from 'react-router';
import { usePracticeTrends } from '../../api/practice-hooks';
import { QueryView } from '../../components/QueryView';
import { linkClass } from '../../components/ui';
import { PlanGate } from '../../plan/PlanGate';
import { PracticeTrendChart } from './PracticeTrendChart';

function Trends({ planId }: { planId: string }) {
  const query = usePracticeTrends(planId);
  return (
    <QueryView query={query} label="Loading your practice scores…">
      {({ kinds }) =>
        kinds.length === 0 ? (
          <p className="text-muted">
            No practice scores yet. After you finish a practice with a score, one chart per kind of
            practice appears here. Practice that was saved as free text has no score.
          </p>
        ) : (
          <div className="space-y-8">
            {kinds.map((k) => (
              <PracticeTrendChart key={k.kind} trend={k} />
            ))}
          </div>
        )
      }
    </QueryView>
  );
}

/** /practice-history: the score over time for each kind of practice. Read-only. */
export function PracticeTrendsPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link to="/week" className={`${linkClass} inline-flex min-h-11 items-center`}>
          Back to Week
        </Link>
        <h1>Practice scores</h1>
      </div>
      <PlanGate empty={<p className="text-muted">There is no plan yet. Import one on Today.</p>}>
        {(plan) => <Trends planId={plan.id} />}
      </PlanGate>
    </div>
  );
}
