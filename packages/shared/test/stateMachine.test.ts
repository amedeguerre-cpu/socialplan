import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  backoffSeconds,
  canTransition,
  CANCELLABLE,
  POST_STATUSES,
  TransitionError,
  type Actor,
  type PostStatus,
} from '../src';

const cases: [PostStatus, PostStatus, Actor, boolean][] = [
  ['draft', 'scheduled', 'human', true],
  ['scheduled', 'processing', 'system', true],
  ['scheduled', 'processing', 'human', false],
  ['processing', 'published', 'system', true],
  ['processing', 'inbox_sent', 'system', true],
  ['inbox_sent', 'published', 'human', true],
  ['inbox_sent', 'published', 'system', true],
  ['processing', 'needs_action', 'system', true],
  ['processing', 'failed', 'system', true],
  ['needs_action', 'scheduled', 'human', true],
  ['needs_action', 'scheduled', 'system', false],
  ['failed', 'scheduled', 'human', true],
  ['failed', 'scheduled', 'system', false],
  ['published', 'scheduled', 'human', false],
  ['published', 'cancelled', 'human', false],
  ['cancelled', 'scheduled', 'human', false],
  ['scheduled', 'cancelled', 'human', true],
  ['draft', 'published', 'system', false],
  ['scheduled', 'published', 'system', false],
];

describe('durum makinesi', () => {
  it.each(cases)('%s → %s (%s) = %s', (from, to, by, expected) => {
    expect(canTransition(from, to, by)).toBe(expected);
  });

  it('geçersiz geçişte hata fırlatır', () => {
    expect(() => assertTransition('published', 'processing', 'system')).toThrow(TransitionError);
  });

  it('terminal durumlardan çıkış yok', () => {
    for (const to of POST_STATUSES) {
      expect(canTransition('published', to, 'system')).toBe(false);
      expect(canTransition('cancelled', to, 'human')).toBe(false);
    }
  });

  it('iptal edilebilir durumlar', () => {
    expect(CANCELLABLE).toEqual(
      expect.arrayContaining([
        'draft',
        'scheduled',
        'processing',
        'inbox_sent',
        'needs_action',
        'failed',
      ]),
    );
    expect(CANCELLABLE).not.toContain('published');
  });
});

describe('geri çekilme', () => {
  it('1/5/25 dk tabanı + jitter', () => {
    expect(backoffSeconds(1, undefined, () => 0)).toBe(60);
    expect(backoffSeconds(2, undefined, () => 0)).toBe(300);
    expect(backoffSeconds(3, undefined, () => 0)).toBe(1500);
    expect(backoffSeconds(1, undefined, () => 1)).toBe(72);
  });
  it("Retry-After'a uyar", () => {
    expect(backoffSeconds(1, 600, () => 0)).toBe(600);
  });
});
