import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from './bootstrap';

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
});

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  root.remove();
  vi.unstubAllGlobals();
});

describe('mount', () => {
  it('moves pre-rename storage keys over before the app reads them', () => {
    window.localStorage.setItem('skillstack.theme', 'dark');
    mount(root, { VITE_API_URL: 'localhost:3000', VITE_APP_ENV: 'staging' });
    expect(window.localStorage.getItem('upversion.theme')).toBe('dark');
    expect(window.localStorage.getItem('skillstack.theme')).toBeNull();
  });

  it('shows a readable message instead of a blank page when the environment is invalid', () => {
    mount(root, { VITE_API_URL: 'localhost:3000', VITE_APP_ENV: 'staging' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Upversion could not start');
    expect(alert).toHaveTextContent(/VITE_API_URL/);
    expect(alert).toHaveTextContent(/VITE_APP_ENV/);
    expect(alert).toHaveTextContent(/VITE_SUPABASE_URL/);
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
  });

  it('renders the app when the environment is valid', async () => {
    await act(async () =>
      mount(root, {
        VITE_APP_ENV: 'rnd',
        VITE_API_URL: 'https://api.test',
        VITE_SUPABASE_URL: 'https://project.supabase.test',
        VITE_SUPABASE_ANON_KEY: 'anon-key-placeholder',
      }),
    );
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByText('R&D environment')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
