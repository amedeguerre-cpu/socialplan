import { describe, expect, it } from 'vitest';
import {
  pacificDay,
  validateForPlatform,
  weekdayOfYmd,
  ymdInTz,
  zonedToUtc,
  type VideoMeta,
} from '../src';

const MB = 1024 * 1024;
const base: VideoMeta = {
  mime: 'video/mp4',
  originalName: 'a.mp4',
  sizeBytes: 10 * MB,
  durationMs: 30_000,
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: 'avc1',
  audioCodec: 'mp4a',
  bitrateKbps: 5000,
  moovAtStart: true,
};
const codes = (m: Partial<VideoMeta>, p: 'instagram' | 'youtube' | 'tiktok') =>
  validateForPlatform({ ...base, ...m }, p)
    .issues.filter((i) => i.severity === 'error')
    .map((i) => i.code);

describe('doğrulama sınır değerleri', () => {
  it('Instagram: tam 300 MB geçer, 1 bayt fazlası kalmaz', () => {
    expect(codes({ sizeBytes: 300 * MB }, 'instagram')).toEqual([]);
    expect(codes({ sizeBytes: 300 * MB + 1 }, 'instagram')).toEqual(['size']);
  });
  it('Instagram: tam 3 sn geçer, 2,999 sn kalır; tam 15 dk geçer', () => {
    expect(codes({ durationMs: 3000 }, 'instagram')).toEqual([]);
    expect(codes({ durationMs: 2999 }, 'instagram')).toEqual(['duration_min']);
    expect(codes({ durationMs: 900_000 }, 'instagram')).toEqual([]);
    expect(codes({ durationMs: 900_001 }, 'instagram')).toEqual(['duration_max']);
  });
  it('YouTube Shorts: tam 3 dk geçer, üstü kalır; kare video geçer', () => {
    expect(codes({ durationMs: 180_000 }, 'youtube')).toEqual([]);
    expect(codes({ durationMs: 180_001 }, 'youtube')).toEqual(['duration_max']);
    expect(codes({ width: 1080, height: 1080 }, 'youtube')).toEqual([]);
  });
  it('fps 23–60 ve genişlik/kenar sınırları', () => {
    expect(codes({ fps: 23 }, 'instagram')).toEqual([]);
    expect(codes({ fps: 60 }, 'tiktok')).toEqual([]);
    expect(codes({ fps: 61 }, 'tiktok')).toEqual(['fps']);
    expect(codes({ width: 1920, height: 3413 }, 'instagram')).toEqual([]);
    expect(codes({ width: 1921, height: 3414 }, 'instagram')).toEqual(['width']);
    expect(codes({ width: 360, height: 640 }, 'tiktok')).toEqual([]);
    expect(codes({ width: 2304, height: 4096 }, 'tiktok')).toEqual([]);
    expect(codes({ width: 2304, height: 4097 }, 'tiktok')).toEqual(['max_edge']);
  });
  it('bit hızı tam 25 Mbps geçer', () => {
    expect(codes({ bitrateKbps: 25_000 }, 'instagram')).toEqual([]);
    expect(codes({ bitrateKbps: 25_001 }, 'instagram')).toEqual(['bitrate']);
  });
});

describe('saat sınırları', () => {
  it('İstanbul gece yarısı: Pazartesi 00:30 yerel = Pazar 21:30 UTC', () => {
    const at = zonedToUtc('2026-11-09', '00:30', 'Europe/Istanbul');
    expect(at.toISOString()).toBe('2026-11-08T21:30:00.000Z');
    expect(ymdInTz(at, 'Europe/Istanbul')).toBe('2026-11-09');
    expect(weekdayOfYmd(ymdInTz(at, 'Europe/Istanbul'))).toBe(1);
    expect(ymdInTz(at, 'UTC')).toBe('2026-11-08');
  });
  it('yıl sınırı ve 23:59', () => {
    expect(zonedToUtc('2027-01-01', '02:59', 'Europe/Istanbul').toISOString()).toBe(
      '2026-12-31T23:59:00.000Z',
    );
  });
  it('Pasifik günü yaz (PDT, UTC-7) ve kış (PST, UTC-8) saatinde doğru', () => {
    expect(pacificDay('2026-07-01T06:59:00Z')).toBe('2026-06-30');
    expect(pacificDay('2026-07-01T07:00:00Z')).toBe('2026-07-01');
    expect(pacificDay('2026-11-05T07:59:59Z')).toBe('2026-11-04');
    expect(pacificDay('2026-11-05T08:00:00Z')).toBe('2026-11-05');
    // DST geçiş günü (1 Kasım 2026)
    expect(pacificDay('2026-11-01T07:30:00Z')).toBe('2026-11-01');
  });
});

describe('DST boşluğu ve belirsiz saat (inceleme bulgusu 5)', () => {
  it('ilkbahar boşluğunda yerel saat ileri kayar (LA 2026-03-08 02:30 → 03:30 PDT)', () => {
    const at = zonedToUtc('2026-03-08', '02:30', 'America/Los_Angeles');
    expect(at.toISOString()).toBe('2026-03-08T10:30:00.000Z');
  });
  it('sonbaharda tekrar eden saatte erken an seçilir (LA 2026-11-01 01:30 → 08:30Z PDT)', () => {
    expect(zonedToUtc('2026-11-01', '01:30', 'America/Los_Angeles').toISOString()).toBe(
      '2026-11-01T08:30:00.000Z',
    );
  });
  it('geçiş dışındaki saatler ve İstanbul etkilenmez', () => {
    expect(zonedToUtc('2026-03-08', '01:59', 'America/Los_Angeles').toISOString()).toBe(
      '2026-03-08T09:59:00.000Z',
    );
    expect(zonedToUtc('2026-03-08', '03:00', 'America/Los_Angeles').toISOString()).toBe(
      '2026-03-08T10:00:00.000Z',
    );
    expect(zonedToUtc('2026-03-29', '03:30', 'Europe/Istanbul').toISOString()).toBe(
      '2026-03-29T00:30:00.000Z',
    );
  });
});
