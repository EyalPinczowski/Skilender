import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { Task } from '../api/client';
import { useDeletePlan, useTasks } from '../api/hooks';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { QueryView } from '../components/QueryView';
import { TaskStatusLabel, TaskTypeChip } from '../components/TaskChips';
import { Button, ErrorText, linkClass } from '../components/ui';
import { describeError, isConnectionProblem } from '../lib/messages';
import { formatHours } from '../lib/format';
import { anchorText, dependencyText } from '../lib/task-text';
import { TASK_TYPE_META } from '../lib/task-types';
import { ImportPlan } from '../plan/ImportPlan';
import { PlanGate, PlanSwitcher } from '../plan/PlanGate';

function TaskRow({ task, titleOf }: { task: Task; titleOf: (id: string) => string }) {
  const deps = dependencyText(task, titleOf);
  const anchor = anchorText(task);
  return (
    <li
      className={`space-y-2 rounded-md border border-l-4 border-border bg-surface p-4 ${TASK_TYPE_META[task.type].strip}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <TaskTypeChip type={task.type} />
        <TaskStatusLabel status={task.status} />
        <span className="ml-auto text-muted tabular-nums">
          {formatHours(task.doneHours)} of {formatHours(task.estHours)}
        </span>
      </div>
      <h3 className="text-lg font-bold">
        <Link
          to={`/plan/${encodeURIComponent(task.id)}`}
          className={`${linkClass} inline-block min-h-11 py-2`}
        >
          {task.title}
        </Link>
      </h3>
      {anchor ? <p className="font-bold">{anchor}</p> : null}
      {deps ? <p className="text-muted">{deps}</p> : null}
    </li>
  );
}

/** Every task of the plan, in plan order. */
export function PlanPage() {
  const [deleted, setDeleted] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  // The deleted plan's button is gone: focus moves to the page heading, which stays.
  useEffect(() => {
    if (deleted) heading.current?.focus();
  }, [deleted]);
  return (
    <div className="space-y-6">
      <h1 ref={heading} tabIndex={-1}>
        Plan
      </h1>
      <div role="status" className="font-bold text-ok empty:hidden">
        {deleted ? 'Plan deleted.' : null}
      </div>
      <PlanSwitcher />
      <PlanGate
        empty={
          <p className="text-muted">
            No plan yet. Import one from{' '}
            <Link to="/" className={linkClass}>
              Today
            </Link>
            .
          </p>
        }
      >
        {(plan) => (
          <>
            <TaskList planId={plan.id} name={plan.name} />
            <ManagePlans
              key={plan.id}
              planId={plan.id}
              name={plan.name}
              onDeleted={() => setDeleted(true)}
            />
          </>
        )}
      </PlanGate>
    </div>
  );
}

function TaskList({ planId, name }: { planId: string; name: string }) {
  const tasks = useTasks(planId);
  return (
    <QueryView query={tasks} label="Loading your tasks…">
      {({ tasks: list }) => {
        const titleOf = (id: string) => list.find((t) => t.id === id)?.title ?? id;
        return (
          <section aria-labelledby="tasks-heading" className="space-y-3">
            <h2 id="tasks-heading">{name}</h2>
            <p className="text-muted">{list.length} tasks</p>
            <ul className="space-y-3">
              {list.map((task) => (
                <TaskRow key={task.id} task={task} titleOf={titleOf} />
              ))}
            </ul>
          </section>
        );
      }}
    </QueryView>
  );
}

function ManagePlans({
  planId,
  name,
  onDeleted,
}: {
  planId: string;
  name: string;
  onDeleted: () => void;
}) {
  const remove = useDeletePlan();
  const [confirming, setConfirming] = useState(false);
  return (
    <section aria-labelledby="manage-heading" className="space-y-4 border-t border-border pt-6">
      <h2 id="manage-heading">Manage plans</h2>
      <div className="space-y-2">
        <Button variant="danger" onClick={() => setConfirming(true)}>
          Delete this plan
        </Button>
        {remove.error ? (
          <ErrorText>
            {isConnectionProblem(remove.error)
              ? describeError(remove.error, '')
              : 'The plan could not be deleted. Nothing was changed. Try again in a moment.'}
          </ErrorText>
        ) : null}
      </div>
      <details className="rounded-sm border border-border">
        <summary className="flex min-h-11 cursor-pointer items-center px-3 font-bold">
          Import another plan
        </summary>
        <div className="px-3 pb-3 pt-2">
          <ImportPlan />
        </div>
      </details>
      {confirming ? (
        <ConfirmDialog
          title={`Delete “${name}”?`}
          confirmLabel={remove.isPending ? 'Deleting…' : 'Delete plan'}
          cancelLabel="Keep this plan"
          busy={remove.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() =>
            remove.mutate(planId, {
              onSuccess: onDeleted,
              onSettled: () => setConfirming(false),
            })
          }
        >
          <p>
            Your progress and the calendar events Upversion created for this plan are removed. This
            cannot be undone.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
