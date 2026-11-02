import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { FinishDialog, type FinishChoice } from './FinishDialog';

function setup(
  props: Partial<{
    choice: FinishChoice;
    defaultHours: number | null;
    busy: boolean;
    error: string | null;
  }> = {},
) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <FinishDialog
      choice={props.choice ?? { kind: 'rubric', checkedSteps: [0, 1], total: 3 }}
      defaultHours={props.defaultHours === undefined ? 0.5 : props.defaultHours}
      busy={props.busy ?? false}
      error={props.error ?? null}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
  );
  return { onSubmit, onCancel, ...view };
}

describe('FinishDialog', () => {
  it('describes what will be saved', () => {
    setup();
    expect(
      screen.getByRole('dialog', { name: 'Finish this practice' }),
    ).toHaveAccessibleDescription('Self-check: 2 of 3 steps ticked.');
  });

  it('never marks the task done unless the box is ticked', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    const box = screen.getByRole('checkbox', { name: 'Mark task done' });
    expect(box).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Finish practice' }));
    expect(onSubmit).toHaveBeenCalledWith({ markDone: false, logHours: 0.5 });
  });

  it('sends markDone only after the explicit choice', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.click(screen.getByRole('checkbox', { name: 'Mark task done' }));
    await user.click(screen.getByRole('button', { name: 'Finish practice' }));
    expect(onSubmit).toHaveBeenCalledWith({ markDone: true, logHours: 0.5 });
  });

  it('logs nothing when the hours are empty', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.clear(screen.getByLabelText('Hours to log'));
    await user.click(screen.getByRole('button', { name: 'Finish practice' }));
    expect(onSubmit).toHaveBeenCalledWith({ markDone: false, logHours: null });
  });

  it('rejects hours that are not a number, in words', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    const field = screen.getByLabelText('Hours to log');
    await user.clear(field);
    await user.type(field, 'lots');
    await user.click(screen.getByRole('button', { name: 'Finish practice' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/number from 0 to 12/);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('accepts a decimal comma', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    const field = screen.getByLabelText('Hours to log');
    await user.clear(field);
    await user.type(field, '1,5');
    await user.click(screen.getByRole('button', { name: 'Finish practice' }));
    expect(onSubmit).toHaveBeenCalledWith({ markDone: false, logHours: 1.5 });
  });

  it('puts focus in the dialog, traps Tab, and cancels on Escape', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    expect(screen.getByLabelText('Hours to log')).toHaveFocus();
    await user.tab(); // checkbox
    await user.tab(); // Back
    await user.tab(); // Finish practice
    await user.tab(); // wraps to the first field
    expect(screen.getByLabelText('Hours to log')).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Finish practice' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });

  it('shows an error from the server and disables the buttons while saving', () => {
    setup({ error: 'This task was skipped. Reopen it first.', busy: true });
    expect(screen.getByRole('alert')).toHaveTextContent('This task was skipped. Reopen it first.');
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Back' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('keeps focus on the pressed button while saving, and ignores presses', async () => {
    const user = userEvent.setup();
    const { onSubmit, onCancel, rerender } = setup();
    const finish = screen.getByRole('button', { name: 'Finish practice' });
    finish.focus();
    rerender(
      <FinishDialog
        choice={{ kind: 'none' }}
        defaultHours={0.5}
        busy
        error={null}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    const saving = screen.getByRole('button', { name: 'Saving…' });
    expect(saving).toHaveFocus();
    await user.click(saving);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
  });

  it('moves focus to the error when the save fails', () => {
    const { rerender, onSubmit, onCancel } = setup();
    screen.getByRole('button', { name: 'Finish practice' }).focus();
    rerender(
      <FinishDialog
        choice={{ kind: 'none' }}
        defaultHours={0.5}
        busy={false}
        error="Could not save."
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).toHaveTextContent('Could not save.');
  });

  it('makes the rest of the page inert while open and restores it on close', () => {
    const page = document.createElement('div');
    page.id = 'page';
    document.body.appendChild(page);
    const { unmount } = setup();
    expect(page).toHaveAttribute('inert');
    unmount();
    expect(page).not.toHaveAttribute('inert');
    page.remove();
  });

  it('has no accessibility violations', async () => {
    setup();
    await expectNoAxeViolations(document.body);
  });
});
