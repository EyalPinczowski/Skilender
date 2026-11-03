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

  it('collapses line breaks and control characters in titles, plan names and steps', () => {
    expect(eventSummary('course', 'A\nB\u0007\tC')).toBe('Course: A B C');
    const d = eventDescription({
      planName: 'P\r\nQ',
      type: 'course',
      estHours: 1,
      steps: ['one\ntwo\u0000three'],
    });
    expect(d).toBe('Plan: P Q\nType: Course\nEstimate: 1 h\n\nSteps:\n1. one two three');
  });

  it('validates the link with URL and omits anything odd', () => {
    const d = (url: string) =>
      eventDescription({ planName: 'P', type: 'course', estHours: 1, url });
    expect(d('https://example.com/a b')).not.toContain('Link');
    expect(d('https://example.com/\nHTTP')).not.toContain('Link');
    expect(d('ftp://example.com')).not.toContain('Link');
    expect(d('not a url')).not.toContain('Link');
    expect(d('https://example.com/a?x=1&y=2')).toContain('Link: https://example.com/a?x=1&amp;y=2');
  });

  it('escapes < > & so the description cannot render as markup', () => {
    const d = eventDescription({
      planName: '<a href="x">me</a> & you',
      type: 'course',
      estHours: 1,
      steps: ['<b>bold</b>'],
    });
    expect(d).not.toMatch(/<[a-z/]/i);
    expect(d).toContain('Plan: &lt;a href="x"&gt;me&lt;/a&gt; &amp; you');
    expect(d).toContain('1. &lt;b&gt;bold&lt;/b&gt;');
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
