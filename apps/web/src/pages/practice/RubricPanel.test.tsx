import { GENERIC_RUBRIC_STEPS } from '@skillstack/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { rubricSteps } from './practice-utils';
import { RubricPanel } from './RubricPanel';

const TEXTS = ['Set a timer', 'Answer out loud', 'Write down one lesson'];
const STEPS = TEXTS.map((text, index) => ({ text, index }));

describe('rubricSteps', () => {
  it('uses the generic steps when the task has none', () => {
    expect(rubricSteps([]).map((s) => s.text)).toEqual(GENERIC_RUBRIC_STEPS);
    expect(rubricSteps(['  ']).map((s) => s.text)).toEqual(GENERIC_RUBRIC_STEPS);
    expect(rubricSteps(TEXTS)).toEqual(STEPS);
  });

  it('leaves blank steps out but keeps the positions the API expects', () => {
    expect(rubricSteps(['One', '  ', 'Three'])).toEqual([
      { text: 'One', index: 0 },
      { text: 'Three', index: 2 },
    ]);
  });
});

describe('RubricPanel', () => {
  it('sends the original positions when blank steps were left out', async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<RubricPanel steps={rubricSteps(['One', ' ', 'Three'])} onFinish={onFinish} />);
    await user.click(screen.getByRole('checkbox', { name: 'Three' }));
    await user.click(screen.getByRole('button', { name: 'Finish with this self-check' }));
    expect(onFinish).toHaveBeenCalledWith({ kind: 'rubric', checkedSteps: [2], total: 2 });
  });

  it('disables the mode choice too when disabled', () => {
    render(<RubricPanel steps={STEPS} onFinish={() => {}} disabled />);
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });

  it('marks both score fields invalid and linked to the error', async () => {
    const user = userEvent.setup();
    render(<RubricPanel steps={STEPS} onFinish={() => {}} />);
    await user.click(screen.getByRole('radio', { name: 'Entering a score I got elsewhere' }));
    await user.click(screen.getByRole('button', { name: 'Finish with this self-check' }));
    const alert = await screen.findByRole('alert');
    for (const name of ['My score', 'Maximum score']) {
      const field = screen.getByLabelText(name);
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(field).toHaveAttribute('aria-describedby', alert.id);
    }
  });

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
