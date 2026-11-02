import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { PasteFeedback } from './PasteFeedback';

const BLOCK = '===FEEDBACK===\nscore: 7/10\nstrengths: ok\nimprove: more\nnext_focus: x\n===END===';

describe('PasteFeedback', () => {
  it('asks for text before finishing', async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<PasteFeedback onFinish={onFinish} />);
    await user.click(screen.getByRole('button', { name: 'Finish with this feedback' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Paste the reply first.');
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('hands over a feedback block as it was pasted', async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<PasteFeedback onFinish={onFinish} />);
    await user.click(screen.getByLabelText('Reply from your assistant'));
    await user.paste(BLOCK);
    await user.click(screen.getByRole('button', { name: 'Finish with this feedback' }));
    expect(onFinish).toHaveBeenCalledWith({ kind: 'paste', text: BLOCK });
  });

  it('accepts unformatted text as free text', async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<PasteFeedback onFinish={onFinish} />);
    await user.click(screen.getByLabelText('Reply from your assistant'));
    await user.paste('You did well. Maybe be more concrete next time.');
    await user.click(screen.getByRole('button', { name: 'Finish with this feedback' }));
    expect(onFinish).toHaveBeenCalledWith({
      kind: 'paste',
      text: 'You did well. Maybe be more concrete next time.',
    });
  });

  it('keeps the pasted draft out of browser storage', async () => {
    const user = userEvent.setup();
    window.localStorage.clear();
    render(<PasteFeedback onFinish={() => {}} />);
    await user.click(screen.getByLabelText('Reply from your assistant'));
    await user.paste(BLOCK);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<PasteFeedback onFinish={() => {}} />);
    await expectNoAxeViolations(container);
  });
});
