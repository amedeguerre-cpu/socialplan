import { describe, expect, it } from 'vitest';
import {
  addDaysYmd,
  hmInTz,
  pacificDay,
  weekdayOfYmd,
  weekStartYmd,
  ymdInTz,
  zonedParts,
  zonedToUtc,
} from '../src';

const IST = 'Europe/Istanbul';

describe('saat dönüşümleri', () => {
  it('İstanbul (UTC+3) → UTC', () => {
    expect(zonedToUtc('2026-11-05', '09:00', IST).toISOString()).toBe('2026-11-05T06:00:00.000Z');
    expect(zonedToUtc('2026-01-01', '00:30', IST).toISOString()).toBe('2025-12-31T21:30:00.000Z');
  });
  it('UTC → İstanbul', () => {
    const d = new Date('2026-11-05T21:15:00Z');
    expect(ymdInTz(d, IST)).toBe('2026-11-06');
    expect(hmInTz(d, IST)).toBe('00:15');
    expect(zonedParts(d, IST).weekday).toBe(5); // Cuma
  });
  it('DST olan bölgede (Los Angeles) doğru ofset', () => {
    expect(zonedToUtc('2026-07-01', '12:00', 'America/Los_Angeles').toISOString()).toBe(
      '2026-07-01T19:00:00.000Z',
    );
    expect(zonedToUtc('2026-12-01', '12:00', 'America/Los_Angeles').toISOString()).toBe(
      '2026-12-01T20:00:00.000Z',
    );
  });
  it('Pasifik günü (YouTube kota)', () => {
    expect(pacificDay(new Date('2026-11-05T07:59:00Z'))).toBe('2026-11-04');
    expect(pacificDay(new Date('2026-11-05T08:01:00Z'))).toBe('2026-11-05');
  });
  it('gün yardımcıları', () => {
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
    expect(weekdayOfYmd('2026-11-09')).toBe(1);
    expect(weekdayOfYmd('2026-11-08')).toBe(7);
    expect(weekStartYmd(new Date('2026-11-08T22:00:00Z'), IST)).toBe('2026-11-09');
  });
});
