import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'data/**',
      'apps/web/src/api/schema.d.ts',
      '.claude/worktrees/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Spec 3.8: only the write guard may write calendar events. Its provider methods also demand a
    // guard-branded target (a compile-time check); this rule is the second layer.
    files: ['apps/api/**/*.ts'],
    ignores: ['apps/api/src/modules/calendar/write-guard.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.property.name=/^(insertEvent|patchEvent|deleteEvent)$/][callee.object.name=/provider/i], CallExpression[callee.property.name=/^(insertEvent|patchEvent|deleteEvent)$/][callee.object.property.name=/provider/i], CallExpression[callee.property.value=/^(insertEvent|patchEvent|deleteEvent)$/][callee.object.name=/provider/i], CallExpression[callee.property.value=/^(insertEvent|patchEvent|deleteEvent)$/][callee.object.property.name=/provider/i]',
          message:
            'Calendar events may only be written through the write guard (modules/calendar/write-guard.ts, spec 3.8).',
        },
      ],
    },
  },
  {
    // These tests exercise the provider's write methods directly, on purpose.
    files: [
      'apps/api/test/calendar-google-provider.test.ts',
      'apps/api/test/calendar-write-guard.test.ts',
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
);
