/**
 * Title and details of the events the app writes (spec 3.8). Pure: the owner's own plan data in,
 * plain text out. Nothing else goes into an event: no AI text, no data from other calendars.
 */

const TYPE_LABELS: Record<string, string> = {
  course: 'Course',
  cert_exam: 'Exam',
  practice: 'Practice',
  admin: 'Admin',
  cv_update: 'CV',
};

export const EVENT_SUMMARY_MAX = 300;
export const EVENT_DESCRIPTION_MAX = 1500;
const STEP_MAX = 300;
const MAX_STEPS = 12;

/** One line: control characters and line breaks become spaces, runs of spaces collapse. */
const oneLine = (text: string) =>
  text
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
/** Google renders a description as limited HTML: escape so text can never become markup. */
const esc = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** The link as one clean http(s) URL, or null. */
function safeUrl(raw: string | null | undefined): string | null {
  if (!raw || /\s/.test(raw) || /\p{Cc}/u.test(raw)) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** `Course`, `Exam`, `Practice`, `Admin` or `CV`. */
export function eventTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? 'Task';
}

/** `<Type>: <task title>`, capped. */
export function eventSummary(type: string, title: string): string {
  return oneLine(`${eventTypeLabel(type)}: ${title}`).slice(0, EVENT_SUMMARY_MAX);
}

export interface EventDetails {
  planName: string;
  type: string;
  estHours: number;
  url?: string | null | undefined;
  steps?: readonly string[] | undefined;
}

/** Plan name, type, estimate, link (http/https only) and the how-to steps; one line each. */
export function eventDescription(d: EventDetails): string {
  const lines = [
    `Plan: ${esc(oneLine(d.planName))}`,
    `Type: ${eventTypeLabel(d.type)}`,
    `Estimate: ${Number(d.estHours.toFixed(1))} h`,
  ];
  const url = safeUrl(d.url);
  if (url) lines.push(`Link: ${esc(url)}`);
  const steps = (d.steps ?? []).map((s) => oneLine(s)).filter((s) => s !== '');
  if (steps.length > 0) {
    lines.push('', 'Steps:');
    steps
      .slice(0, MAX_STEPS)
      .forEach((s, i) => lines.push(`${i + 1}. ${esc(s.slice(0, STEP_MAX))}`));
  }
  // Cut at a line end, so an escape such as &amp; is never split.
  let out = '';
  for (const line of lines) {
    const next = out === '' ? line : `${out}\n${line}`;
    if (next.length > EVENT_DESCRIPTION_MAX) break;
    out = next;
  }
  return out;
}
