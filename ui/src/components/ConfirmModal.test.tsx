import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConfirmModal from './ConfirmModal';

const onConfirm = vi.fn<() => Promise<void>>();
const onClose = vi.fn();

function renderModal(): void {
  render(
    <ConfirmModal title="Remove post" confirmLabel="Remove" busyLabel="Removing…" onConfirm={onConfirm} onClose={onClose}>
      Remove this post?
    </ConfirmModal>,
  );
}

// jsdom's <dialog> has no showModal, and a closed dialog hides its content.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

beforeEach(() => vi.clearAllMocks());

describe('ConfirmModal', () => {
  it('runs the action only on confirm, then closes', async () => {
    const user = userEvent.setup();
    onConfirm.mockResolvedValue();
    renderModal();
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels without running the action', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('stays open and shows the message when the action fails', async () => {
    const user = userEvent.setup();
    onConfirm.mockRejectedValue(new Error('Delete failed'));
    renderModal();

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(await screen.findByText('Delete failed')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled();
  });
});
