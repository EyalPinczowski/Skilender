import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { promptBody } from '../../test/practice-fixtures';
import { PromptPanel } from './PromptPanel';

afterEach(() => {
  vi.restoreAllMocks();
});

function clipboard(writeText: () => Promise<void> = async () => {}) {
  const spy = vi.fn(writeText);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: spy }, configurable: true });
  return spy;
}

describe('PromptPanel', () => {
  it('shows the prompt and what went into it', () => {
    render(
      <PromptPanel
        prompt={promptBody({
          inputs: {
            nextFocus: 'Quantify the result',
            nextFocusFrom: 's1',
            topics: ['Intro to SQL', 'Joins'],
            jobDescriptionIncluded: true,
            redactions: 2,
          },
        })}
      />,
    );
    expect(screen.getByLabelText('Practice prompt')).toHaveTextContent('Ask me three questions.');
    expect(screen.getByText(/Your last focus point: Quantify the result/)).toBeInTheDocument();
    expect(screen.getByText(/Intro to SQL, Joins/)).toBeInTheDocument();
    expect(screen.getByText('Your job description is included.')).toBeInTheDocument();
    expect(screen.getByText('2 personal details were removed.')).toBeInTheDocument();
  });

  it('copies the prompt and announces "Copied" once in one polite region', async () => {
    const user = userEvent.setup();
    const writeText = clipboard();
    render(<PromptPanel prompt={promptBody()} />);
    await user.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(writeText).toHaveBeenCalledWith(promptBody().prompt);
    const regions = screen.getAllByRole('status');
    expect(regions).toHaveLength(1);
    expect(regions[0]).toHaveTextContent('Copied');
    expect(regions[0]).toHaveAttribute('aria-live', 'polite');
  });

  it('Open in Claude copies the prompt and links to https://claude.ai/new in a new tab', async () => {
    const user = userEvent.setup();
    const writeText = clipboard();
    render(<PromptPanel prompt={promptBody()} />);
    const link = screen.getByRole('link', { name: /Open in Claude/ });
    expect(link).toHaveAttribute('href', 'https://claude.ai/new');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    // No prompt is put in the address: a prefill parameter is not used.
    expect(link.getAttribute('href')).not.toContain('?');
    await user.click(link);
    expect(writeText).toHaveBeenCalledWith(promptBody().prompt);
  });

  it('says so when copying is refused and nothing else can copy', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<PromptPanel prompt={promptBody()} />);
    await user.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/copy it by hand/i);
    expect(screen.queryByText('Copied')).toBeNull();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<PromptPanel prompt={promptBody()} />);
    await expectNoAxeViolations(container);
  });
});
