import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KeyValueEditor, { type Pair } from './KeyValueEditor';

describe('KeyValueEditor', () => {
  it('shows an empty-state message with no pairs', () => {
    render(<KeyValueEditor pairs={[]} onChange={() => {}} />);
    expect(screen.getByText('No entries.')).toBeInTheDocument();
  });

  it('adds a row when "Add row" is clicked', async () => {
    const onChange = vi.fn();
    render(<KeyValueEditor pairs={[]} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /add row/i }));
    expect(onChange).toHaveBeenCalledWith([{ key: '', value: '' }]);
  });

  it('edits a pair value and reports the updated list', async () => {
    const pairs: Pair[] = [{ key: 'views', value: '' }];
    const onChange = vi.fn();
    render(<KeyValueEditor pairs={pairs} onChange={onChange} valuePlaceholder="count" />);
    await userEvent.type(screen.getByPlaceholderText('count'), '5');
    expect(onChange).toHaveBeenLastCalledWith([{ key: 'views', value: '5' }]);
  });

  it('removes a row', async () => {
    const pairs: Pair[] = [{ key: 'a', value: '1' }, { key: 'b', value: '2' }];
    const onChange = vi.fn();
    render(<KeyValueEditor pairs={pairs} onChange={onChange} />);
    const removeButtons = screen.getAllByRole('button', { name: /remove row/i });
    await userEvent.click(removeButtons[0]);
    expect(onChange).toHaveBeenCalledWith([{ key: 'b', value: '2' }]);
  });
});
