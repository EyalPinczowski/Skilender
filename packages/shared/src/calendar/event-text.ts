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

const strip = (text: string) => text.replaceAll('\u0000', '').replace(/\r\n?/g, '\n');

/** `Course`, `Exam`, `Practice`, `Admin` or `CV`. */
export function eventTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? 'Task';
}

/** `<Type>: <task title>`, capped. */
export function eventSummary(type: string, title: string): string {
  return strip(`${eventTypeLabel(type)}: ${title}`).slice(0, EVENT_SUMMARY_MAX);
}

export interface EventDetails {
  planName: string;
  type: string;
  estHours: number;
  url?: string | null | undefined;
  steps?: readonly string[] | undefined;
}

/** Plan name, type, estimate, link (http/https only) and the how-to steps; newlines allowed. */
export function eventDescription(d: EventDetails): string {
  const lines = [
    `Plan: ${strip(d.planName)}`,
    `Type: ${eventTypeLabel(d.type)}`,
    `Estimate: ${Number(d.estHours.toFixed(1))} h`,
  ];
  if (d.url && /^https?:\/\//i.test(d.url)) lines.push(`Link: ${strip(d.url)}`);
  const steps = (d.steps ?? []).map((s) => strip(s).trim()).filter((s) => s !== '');
  if (steps.length > 0) {
    lines.push('', 'Steps:');
    steps.slice(0, MAX_STEPS).forEach((s, i) => lines.push(`${i + 1}. ${s.slice(0, STEP_MAX)}`));
  }
  return lines.join('\n').slice(0, EVENT_DESCRIPTION_MAX);
}
