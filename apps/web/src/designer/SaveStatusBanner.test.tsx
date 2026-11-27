import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SaveStatusBanner } from './SaveStatusBanner';

describe('SaveStatusBanner', () => {
  it('shows a save conflict and offers to resend the local draft', async () => {
    const onResend = vi.fn();
    render(<SaveStatusBanner status="conflict" onResend={onResend} />);

    expect(screen.getByRole('status')).toHaveTextContent('Konflikt');
    await userEvent.click(screen.getByRole('button', { name: 'Erneut senden' }));
    expect(onResend).toHaveBeenCalledTimes(1);
  });

  it('shows save errors with their message', () => {
    render(<SaveStatusBanner status="error" error="Verbindung fehlgeschlagen" onRetry={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('Verbindung fehlgeschlagen');
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
  });

  it('renders nothing while idle or saved without a message', () => {
    const { container } = render(<SaveStatusBanner status="idle" />);
    expect(container).toBeEmptyDOMElement();
  });
});
