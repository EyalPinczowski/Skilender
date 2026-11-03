import { describe, expect, it } from 'vitest';
import {
  EVENT_DESCRIPTION_MAX,
  EVENT_SUMMARY_MAX,
  eventDescription,
  eventSummary,
  eventTypeLabel,
} from './event-text';

describe('event text', () => {
  it('labels the task types', () => {
    expect(['course', 'cert_exam', 'practice', 'admin', 'cv_update'].map(eventTypeLabel)).toEqual([
      'Course',
      'Exam',
      'Practice',
      'Admin',
      'CV',
    ]);
  });

  it('puts the type in front of the title and caps it', () => {
    expect(eventSummary('cert_exam', 'AZ-900')).toBe('Exam: AZ-900');
    expect(eventSummary('course', 'x'.repeat(500))).toHaveLength(EVENT_SUMMARY_MAX);
  });

  it('describes the plan, type, estimate, link and steps', () => {
    expect(
      eventDescription({
        planName: 'My plan',
        type: 'course',
        estHours: 12.25,
        url: 'https://example.com/c',
        steps: ['Enrol', '  ', 'Watch week 1'],
      }),
    ).toBe(
      'Plan: My plan\nType: Course\nEstimate: 12.3 h\nLink: https://example.com/c\n\nSteps:\n1. Enrol\n2. Watch week 1',
    );
  });

  it('leaves out a missing or non-http link and an empty step list, and caps the length', () => {
    const d = eventDescription({ planName: 'P', type: 'admin', estHours: 1, url: 'javascript:x' });
    expect(d).toBe('Plan: P\nType: Admin\nEstimate: 1 h');
    const long = eventDescription({
      planName: 'P',
      type: 'course',
      estHours: 1,
      steps: Array.from({ length: 50 }, () => 'y'.repeat(300)),
    });
    expect(long.length).toBeLessThanOrEqual(EVENT_DESCRIPTION_MAX);
  });
});
