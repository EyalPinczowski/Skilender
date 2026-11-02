import { GENERIC_RUBRIC_STEPS } from '@skillstack/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { rubricSteps } from './practice-utils';
import { RubricPanel } from './RubricPanel';

const STEPS = ['Set a timer', 'Answer out loud', 'Write down one lesson'];

describe('rubricSteps', () => {
  it('uses the generic steps when the task has none', () => {
    expect(rubricSteps([])).toEqual(GENERIC_RUBRIC_STEPS);
    expect(rubricSteps(['  '])).toEqual(GENERIC_RUBRIC_STEPS);
    expect(rubricSteps(STEPS)).toEqual(STEPS);
  });
});

describe('RubricPanel', () => {
  it('sends the indexes of the ticked steps and computes no score itself', async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<RubricPanel steps={STEPS} onFinish={onFinish} />);
    await user.click(screen.getByRole('checkbox', { name: 'Set a timer' }));
    await user.click(screen.getByRole('checkbox', { name: 'Write down one lesson' }));
    await user.click(screen.getByRole('button', { name: 'Finish with this self-check' }));
    expect(onFinish).toHaveBeenCalledWith({ kind: 'rubric', checkedSteps: [0, 2], total: 3 });
    expect(screen.queryByText(/score:/i)).toBeNull();
  });

  it('allows finishing with nothing ticked', async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<RubricPanel steps={STEPS} onFinish={onFinish} />);
    await user.click(screen.getByRole('button', { name: 'Finish with this self-check' }));
    expect(onFinish).toHaveBeenCalledWith({ kind: 'rubric', checkedSteps: [], total: 3 });
  });

  it('switches to an entered score and validates it', async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<RubricPanel steps={STEPS} onFinish={onFinish} />);
    await user.click(screen.getByRole('radio', { name: 'Entering a score I got elsewhere' }));
    expect(screen.queryByRole('checkbox')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Finish with this self-check' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Enter your score/);

    await user.type(screen.getByLabelText('My score'), '45');
    await user.type(screen.getByLabelText('Maximum score'), '40');
    await user.click(screen.getByRole('button', { name: 'Finish with this self-check' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/between 0 and the maximum/);
    expect(onFinish).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('My score'));
    await user.type(screen.getByLabelText('My score'), '34');
    await user.click(screen.getByRole('button', { name: 'Finish with this self-check' }));
    expect(onFinish).toHaveBeenCalledWith({ kind: 'score', score: 34, max: 40 });
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<RubricPanel steps={STEPS} onFinish={() => {}} />);
    await expectNoAxeViolations(container);
  });
});
