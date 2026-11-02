import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Calendar data (event titles and times) is personal and must never reach a model (ADR 014,
 * project rule: no personal details are sent to AI models). The simplest guarantee is
 * structural: no AI code path imports calendar code, so a prompt cannot be built from it.
 * If AI context building ever needs the calendar, this test must be replaced by a test of
 * the redaction instead of being deleted.
 */
const API_SRC = fileURLToPath(new URL('../src/', import.meta.url));
const SHARED_SRC = fileURLToPath(new URL('../../../packages/shared/src/', import.meta.url));

// Everything that builds or sends prompts: the gateway and providers, the AI routes, the
// practice chat and the briefing, and the shared prompt builders.
const AI_ROOTS = [
  join(API_SRC, 'ai'),
  join(API_SRC, 'modules/ai'),
  join(API_SRC, 'modules/practice'),
  join(API_SRC, 'modules/briefing'),
  join(SHARED_SRC, 'practice'),
  join(SHARED_SRC, 'briefing.ts'),
];

function sourceFiles(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((name) => sourceFiles(join(path, name)));
}

const IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

describe('calendar data and AI', () => {
  const files = AI_ROOTS.flatMap(sourceFiles).filter((f) => /\.tsx?$/.test(f));

  it('finds the AI code it is meant to guard', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('no AI code imports a calendar module', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(IMPORT)) {
        const target = match[1]!;
        if (/calendar/i.test(target)) offenders.push(`${relative(API_SRC, file)} -> ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no AI code mentions calendar sync data by name', () => {
    const offenders = files.filter((f) =>
      /calendar_busy|calendar_locked_blocks|classifyEvents|toBusyIntervals|CalendarInputs/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(offenders.map((f) => relative(API_SRC, f))).toEqual([]);
  });
});
