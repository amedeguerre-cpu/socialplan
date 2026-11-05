import { describe, expect, it } from 'vitest';
import type { PostDTO } from '@socialplan/shared';
import { bucketPosts, dropTarget, weekDays } from '../src/components/Calendar';

const post = (id: string, at: string): PostDTO =>
  ({ id, scheduled_at: at, status: 'scheduled', platform: 'instagram' }) as unknown as PostDTO;
const IST = 'Europe/Istanbul';

describe('takvim yardımcıları', () => {
  it('hafta günleri pazartesiden başlar', () => {
    expect(weekDays('2026-11-09')).toEqual([
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
    ]);
  });
  it('post’lar İstanbul saatine göre gün × saat hücresine düşer', () => {
    const b = bucketPosts(
      [
        post('a', '2026-11-09T06:30:00Z'),
        post('b', '2026-11-09T21:10:00Z'),
        post('c', '2026-11-09T06:05:00Z'),
      ],
      IST,
    );
    expect(b.get('2026-11-09|9')?.map((p) => p.id)).toEqual(['c', 'a']);
    expect(b.get('2026-11-10|0')?.map((p) => p.id)).toEqual(['b']);
  });
  it('sürükle-bırak hedefi: dakika korunur, slot hedefinde slot saati', () => {
    const p = post('a', '2026-11-09T06:30:00Z'); // 09:30 İstanbul
    expect(dropTarget(p, { ymd: '2026-11-11', hour: 14 }, IST)).toBe('2026-11-11T11:30:00.000Z');
    expect(dropTarget(p, { ymd: '2026-11-11', hour: 18, hm: '18:45' }, IST)).toBe(
      '2026-11-11T15:45:00.000Z',
    );
  });
});
