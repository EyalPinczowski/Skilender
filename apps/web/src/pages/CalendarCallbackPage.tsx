import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useFinishCalendarConnect } from '../api/calendar-hooks';
import { isApiError } from '../api/errors';
import { Loading } from '../components/status';
import { ErrorText, linkClass } from '../components/ui';
import { ConnectButton } from './settings/CalendarSettings';

interface Returned {
  code: string | null;
  state: string | null;
  /** Google's `error` parameter, e.g. `access_denied` when the person pressed Cancel. */
  denied: string | null;
}

function readReturned(search: string): Returned {
  const params = new URLSearchParams(search);
  return { code: params.get('code'), state: params.get('state'), denied: params.get('error') };
}

/**
 * Where Google sends the browser back to. The one-time code and state are taken out of the address
 * bar at once (so they are not kept in history or shared by accident) and sent to the API one time.
 */
export function CalendarCallbackPage() {
  // Read before anything else: replaceState below removes them from window.location.
  const [returned] = useState(() => readReturned(window.location.search));
  const finish = useFinishCalendarConnect();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    window.history.replaceState(window.history.state, '', window.location.pathname);
    if (returned.denied === null && returned.code && returned.state) {
      finish.mutate({ code: returned.code, state: returned.state });
    }
    // Runs once on purpose; `started` guards the second run of React strict mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const invalidLink = returned.denied === null && (!returned.code || !returned.state);

  return (
    <div className="space-y-4">
      <h1>Google Calendar</h1>
      {returned.denied !== null ? (
        <Failure
          text={
            returned.denied === 'access_denied'
              ? 'Google Calendar was not connected because access was not allowed. Nothing was changed.'
              : 'Google did not finish the connection. Nothing was changed.'
          }
        />
      ) : invalidLink ? (
        <Failure text="Sign in, then connect again from Settings." />
      ) : finish.isSuccess ? (
        <div role="status" className="space-y-3">
          <p className="font-bold text-ok">Google Calendar is connected.</p>
          <Link className={linkClass} to="/settings">
            Back to Settings
          </Link>
        </div>
      ) : finish.isError ? (
        <Failure
          text={
            isApiError(finish.error) && finish.error.code === 'scopes_not_granted'
              ? 'Both permissions are needed: seeing your calendars and managing events in the Upversion calendar. Nothing was connected. Try again and allow both.'
              : isApiError(finish.error) && finish.error.kind !== 'http'
                ? 'Can’t reach the server. Check your connection and try connecting again.'
                : 'We couldn’t finish connecting Google Calendar. Nothing was changed. Try again.'
          }
        />
      ) : (
        <Loading label="Finishing the connection…" />
      )}
    </div>
  );
}

function Failure({ text }: { text: string }) {
  return (
    <div className="space-y-3">
      <ErrorText>{text}</ErrorText>
      <div className="flex flex-wrap items-center gap-4">
        <ConnectButton label="Try again" primary />
        <Link className={linkClass} to="/settings">
          Back to Settings
        </Link>
      </div>
    </div>
  );
}
