import { useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import type { Task } from '../../api/client';
import { isApiError } from '../../api/errors';
import { useTasks } from '../../api/hooks';
import {
  useAbandonSession,
  useFinishSession,
  usePasteFeedback,
  usePracticePrompt,
  usePracticeSession,
  useStartSession,
  type FinishedSession,
  type PracticeChannel,
  type SessionDetail,
} from '../../api/practice-hooks';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { QueryView } from '../../components/QueryView';
import { TaskTypeChip } from '../../components/TaskChips';
import { Button, ErrorText, linkClass } from '../../components/ui';
import { describeError, newId } from '../../lib/messages';
import { PlanGate } from '../../plan/PlanGate';
import { formatMinutes } from '../briefing/day-utils';
import { FinishDialog, type FinishChoice, type FinishDecision } from './FinishDialog';
import { FinishedSummary } from './FinishedSummary';
import { JobDescriptionField } from './JobDescriptionField';
import { PasteFeedback } from './PasteFeedback';
import { PromptPanel } from './PromptPanel';
import { rubricSteps } from './practice-utils';
import { RubricPanel } from './RubricPanel';
import { Timer } from './Timer';

/**
 * The id of the running session is remembered so a reload picks it up again. It is only an id: no
 * prompt, job description or feedback is ever stored in the browser.
 */
const storeKey = (planId: string, taskId: string) => `skillstack.practice.${planId}.${taskId}`;

function readStored(planId: string, taskId: string): string | null {
  try {
    return window.localStorage.getItem(storeKey(planId, taskId));
  } catch {
    return null;
  }
}

function writeStored(planId: string, taskId: string, sessionId: string | null) {
  try {
    if (sessionId) window.localStorage.setItem(storeKey(planId, taskId), sessionId);
    else window.localStorage.removeItem(storeKey(planId, taskId));
  } catch {
    // Without storage the page still works; a reload just starts from the start panel.
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function Panel({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-border bg-surface p-4">{children}</div>;
}

const CHANNELS: { value: Exclude<PracticeChannel, 'in_app'>; label: string; hint: string }[] = [
  {
    value: 'external',
    label: 'Use Claude or another assistant',
    hint: 'Copy a ready-made prompt, practise there, then paste the feedback back.',
  },
  {
    value: 'self',
    label: 'Practise on my own',
    hint: 'No assistant. Score yourself with a checklist when you are done.',
  },
];

function StartPanel({
  planId,
  task,
  notice,
  onStarted,
}: {
  planId: string;
  task: Task;
  notice: string | null;
  onStarted: (sessionId: string) => void;
}) {
  const start = useStartSession(planId, task.id);
  const [channel, setChannel] = useState<Exclude<PracticeChannel, 'in_app'>>('external');
  // One id per attempt: repeating a start that got no answer is safe and creates one session.
  const attempt = useRef<{ id: string; channel: PracticeChannel } | null>(null);

  function begin() {
    if (!attempt.current || attempt.current.channel !== channel) {
      attempt.current = { id: newId(), channel };
    }
    start.mutate(attempt.current, {
      onSuccess: (detail) => {
        attempt.current = null;
        onStarted(detail.session.id);
      },
      onError: (error) => {
        // The task already has a running session: the API names it, so carry on with that one.
        if (isApiError(error) && error.code === 'practice_session_active') {
          const existing = UUID.exec(error.message)?.[0];
          if (existing) onStarted(existing);
        }
      },
    });
  }

  const planned = Math.round(task.estHours * 60);
  return (
    <div className="space-y-4">
      {notice ? <p className="text-muted">{notice}</p> : null}
      <Panel>
        <div className="space-y-3">
          <h2>Start practice</h2>
          <p className="text-muted">
            Planned time: {formatMinutes(planned)}. The timer starts now.
          </p>
          <fieldset className="space-y-1">
            <legend className="font-bold">How do you want to practise?</legend>
            {CHANNELS.map((option) => (
              <label key={option.value} className="flex min-h-11 items-start gap-3 py-1">
                <input
                  type="radio"
                  name="channel"
                  checked={channel === option.value}
                  onChange={() => setChannel(option.value)}
                  className="mt-0.5 size-6"
                />
                <span>
                  <span className="block font-bold">{option.label}</span>
                  <span className="block text-muted">{option.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <Button variant="primary" disabled={start.isPending} onClick={begin}>
            {start.isPending ? 'Starting…' : 'Start practice'}
          </Button>
          {start.isError &&
          !(isApiError(start.error) && start.error.code === 'practice_session_active') ? (
            <ErrorText>
              {describeError(start.error, 'The practice could not be started.')}
            </ErrorText>
          ) : null}
        </div>
      </Panel>
      {channel === 'external' ? (
        <Panel>
          <div className="space-y-3">
            <h2>About the role</h2>
            <JobDescriptionField planId={planId} />
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

/** Hours spent so far, rounded to a quarter hour, as a starting value for the log field. */
function suggestedHours(startedAt: string): number | null {
  const minutes = (Date.now() - Date.parse(startedAt)) / 60000;
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.min(12, Math.max(0.25, Math.round(minutes / 15) / 4));
}

function ActiveSession({
  planId,
  task,
  detail,
  onFinished,
  onAbandoned,
}: {
  planId: string;
  task: Task;
  detail: SessionDetail;
  onFinished: (result: FinishedSession) => void;
  onAbandoned: () => void;
}) {
  const { session } = detail;
  const external = session.channel === 'external';
  const prompt = usePracticePrompt(planId, task.id, external);
  const finish = useFinishSession(planId, session.id);
  const paste = usePasteFeedback(planId, session.id);
  const abandon = useAbandonSession(planId, session.id);
  const [choice, setChoice] = useState<FinishChoice | null>(null);
  const [defaultHours, setDefaultHours] = useState<number | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const steps = rubricSteps(task.howToSteps);

  function open(next: FinishChoice) {
    finish.reset();
    paste.reset();
    setDefaultHours(suggestedHours(session.startedAt));
    setChoice(next);
  }

  function submit(decision: FinishDecision) {
    if (!choice) return;
    const common = { markDone: decision.markDone, logHours: decision.logHours };
    const options = { onSuccess: onFinished };
    if (choice.kind === 'paste') {
      paste.mutate({ text: choice.text, ...common }, options);
    } else {
      finish.mutate(
        {
          ...common,
          ...(choice.kind === 'rubric' ? { rubric: { checkedSteps: choice.checkedSteps } } : {}),
          ...(choice.kind === 'score'
            ? { enteredScore: { score: choice.score, max: choice.max } }
            : {}),
        },
        options,
      );
    }
  }

  const failure = finish.error ?? paste.error;
  const busy = finish.isPending || paste.isPending;

  return (
    <div className="space-y-4">
      <Panel>
        <Timer startedAt={session.startedAt} plannedMinutes={session.plannedMinutes} />
      </Panel>

      {task.howToSteps.length > 0 ? (
        <Panel>
          <section aria-labelledby="steps-heading" className="space-y-2">
            <h2 id="steps-heading">What to do</h2>
            <ol className="list-decimal space-y-1 pl-6">
              {task.howToSteps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </section>
        </Panel>
      ) : null}

      {session.channel === 'in_app' ? (
        <Panel>
          <p role="note" className="font-bold">
            This session was started in an in-app chat, which is not available here yet. You can
            finish it with a self-check below, or stop it.
          </p>
        </Panel>
      ) : null}

      {external ? (
        <>
          <Panel>
            <QueryView query={prompt} label="Preparing the prompt…">
              {(data) => <PromptPanel prompt={data} />}
            </QueryView>
          </Panel>
          <Panel>
            <section aria-labelledby="jd-heading" className="space-y-3">
              <h2 id="jd-heading">About the role</h2>
              <JobDescriptionField planId={planId} />
            </section>
          </Panel>
          <Panel>
            <PasteFeedback onFinish={open} />
          </Panel>
        </>
      ) : null}

      <Panel>
        <RubricPanel steps={steps} onFinish={open} />
      </Panel>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => open({ kind: 'none' })}>Finish without feedback</Button>
        <Button variant="danger" onClick={() => setConfirmStop(true)}>
          Stop without saving
        </Button>
        <Link to="/" className={`${linkClass} inline-flex min-h-11 items-center`}>
          Back to Today
        </Link>
      </div>
      {abandon.isError ? (
        <ErrorText>{describeError(abandon.error, 'The practice could not be stopped.')}</ErrorText>
      ) : null}

      {choice ? (
        <FinishDialog
          choice={choice}
          defaultHours={defaultHours}
          busy={busy}
          error={failure ? describeError(failure, 'The practice could not be finished.') : null}
          onSubmit={submit}
          onCancel={() => setChoice(null)}
        />
      ) : null}

      {confirmStop ? (
        <ConfirmDialog
          title="Stop this practice?"
          confirmLabel="Stop practice"
          cancelLabel="Keep practising"
          busy={abandon.isPending}
          onCancel={() => setConfirmStop(false)}
          onConfirm={() =>
            abandon.mutate(undefined, {
              onSuccess: () => {
                setConfirmStop(false);
                onAbandoned();
              },
              onError: () => setConfirmStop(false),
            })
          }
        >
          <p>Nothing is logged and the task stays as it is.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function TaskPractice({ planId, task }: { planId: string; task: Task }) {
  const [sessionId, setSessionId] = useState<string | null>(() => readStored(planId, task.id));
  const [result, setResult] = useState<FinishedSession | null>(null);
  const [stopped, setStopped] = useState(false);
  const detail = usePracticeSession(planId, sessionId);

  function setId(id: string | null) {
    writeStored(planId, task.id, id);
    setSessionId(id);
  }

  function again() {
    setResult(null);
    setStopped(false);
    setId(null);
  }

  let body: ReactNode;
  if (result) {
    body = (
      <FinishedSummary
        feedback={result.feedback}
        extras={{
          loggedHours: result.loggedHours,
          taskStatus: result.task.status,
          replayed: result.replayed,
          parsed: result.parsed,
        }}
        onAgain={again}
      />
    );
  } else if (sessionId && detail.data === undefined) {
    body = (
      <QueryView query={detail} label="Loading your practice…">
        {() => null}
      </QueryView>
    );
  } else if (detail.data && detail.data.session.status === 'active') {
    body = (
      <ActiveSession
        planId={planId}
        task={task}
        detail={detail.data}
        onFinished={(r) => {
          writeStored(planId, task.id, null);
          setResult(r);
        }}
        onAbandoned={() => {
          setStopped(true);
          setId(null);
        }}
      />
    );
  } else if (detail.data && detail.data.session.status === 'finished') {
    body = <FinishedSummary feedback={detail.data.feedback} onAgain={again} />;
  } else {
    body = (
      <StartPanel
        planId={planId}
        task={task}
        notice={stopped ? 'The practice was stopped. Nothing was logged.' : null}
        onStarted={setId}
      />
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <TaskTypeChip type={task.type} />
        {task.practiceKind ? <span className="text-muted">{task.practiceKind}</span> : null}
      </div>
      {body}
    </>
  );
}

function PracticeContent({ planId, taskId }: { planId: string; taskId: string }) {
  const tasks = useTasks(planId);
  return (
    <QueryView query={tasks} label="Loading the task…">
      {({ tasks: all }) => {
        const task = all.find((t) => t.id === taskId);
        if (!task) return <p>This task is not in your plan.</p>;
        return (
          <>
            <p className="text-h2 font-bold">{task.title}</p>
            {task.type !== 'practice' ? (
              <p>This task is not a practice, so it has no practice screen.</p>
            ) : (
              <TaskPractice key={task.id} planId={planId} task={task} />
            )}
          </>
        );
      }}
    </QueryView>
  );
}

/** /practice/:taskId: run one practice with the timer, a prompt, and a way to save the result. */
export function PracticePage() {
  const { taskId } = useParams();
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link to="/" className={`${linkClass} inline-flex min-h-11 items-center`}>
          Back to Today
        </Link>
        <h1>Practice</h1>
      </div>
      <PlanGate empty={<p className="text-muted">There is no plan yet. Import one on Today.</p>}>
        {(plan) =>
          taskId ? (
            <PracticeContent planId={plan.id} taskId={taskId} />
          ) : (
            <p>This task is not in your plan.</p>
          )
        }
      </PlanGate>
    </div>
  );
}
