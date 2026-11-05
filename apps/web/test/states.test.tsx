import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorState } from '../src/components/States';

describe('ErrorState', () => {
  it('hata mesajını ve tekrar dene düğmesini gösterir', () => {
    render(<ErrorState error={new Error('Ağ hatası')} onRetry={() => undefined} />);
    expect(screen.getByRole('alert').textContent).toContain('Ağ hatası');
    expect(screen.getByText('Tekrar dene')).toBeTruthy();
  });
});
