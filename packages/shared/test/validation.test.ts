import { describe, expect, it } from 'vitest';
import {
  buildCaption,
  normalizeCodec,
  positionBetween,
  validateForPlatform,
  validateVideo,
  youtubeTitle,
  type VideoMeta,
} from '../src';

const good: VideoMeta = {
  mime: 'video/mp4',
  originalName: 'a.mp4',
  sizeBytes: 50 * 1024 * 1024,
  durationMs: 30_000,
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: 'avc1.640028',
  audioCodec: 'mp4a.40.2',
  audioSampleRate: 44100,
  bitrateKbps: 8000,
  moovAtStart: true,
};

describe('doğrulama', () => {
  it('uygun video her platformda geçer', () => {
    const r = validateVideo(good);
    expect(r.instagram.ok).toBe(true);
    expect(r.youtube.ok).toBe(true);
    expect(r.tiktok.ok).toBe(true);
  });
  it('Instagram boyut sınırı mesajı', () => {
    const r = validateForPlatform({ ...good, sizeBytes: 412 * 1024 * 1024 }, 'instagram');
    expect(r.ok).toBe(false);
    expect(r.issues[0]?.message).toBe('Instagram: dosya 412 MB, sınır 300 MB');
  });
  it('YouTube Shorts: yatay ve 3 dk üstü reddedilir', () => {
    const r = validateForPlatform(
      { ...good, width: 1920, height: 1080, durationMs: 200_000 },
      'youtube',
    );
    expect(r.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['vertical', 'duration_max']),
    );
  });
  it('moov sonda → Instagram hatası', () => {
    expect(validateForPlatform({ ...good, moovAtStart: false }, 'instagram').ok).toBe(false);
    expect(validateForPlatform({ ...good, moovAtStart: false }, 'tiktok').ok).toBe(true);
  });
  it('fps ve TikTok kenar sınırları', () => {
    expect(validateForPlatform({ ...good, fps: 15 }, 'tiktok').ok).toBe(false);
    expect(validateForPlatform({ ...good, width: 320, height: 568 }, 'tiktok').ok).toBe(false);
  });
  it('creator_info süre üst sınırı geçersiz kılınabilir', () => {
    expect(
      validateForPlatform({ ...good, durationMs: 90_000 }, 'tiktok', { maxDurationSec: 60 }).ok,
    ).toBe(false);
  });
  it('ölçülemeyen fps uyarıdır, hata değil', () => {
    const r = validateForPlatform({ ...good, fps: null }, 'instagram');
    expect(r.ok).toBe(true);
    expect(r.issues[0]?.severity).toBe('warning');
  });
  it('codec normalize', () => {
    expect(normalizeCodec('hvc1.1.6.L93')).toBe('hevc');
    expect(normalizeCodec('vp09.00.10.08')).toBe('vp9');
  });
});

describe('caption ve sıralama', () => {
  const src = {
    title: 'Başlık',
    description: 'Açıklama',
    hashtags: ['a', '#b'],
    caption_overrides: { tiktok: 'TT özel' },
  };
  it('override öncelikli', () => {
    expect(buildCaption(src, 'tiktok')).toBe('TT özel');
    expect(buildCaption(src, 'instagram')).toBe('Açıklama\n\n#a #b');
  });
  it('YouTube başlığı #Shorts ekler ve 100 karakterle sınırlar', () => {
    expect(youtubeTitle(src)).toBe('Başlık #Shorts');
    expect(youtubeTitle({ ...src, title: 'x'.repeat(150) }).length).toBe(100);
  });
  it('kesirli konum', () => {
    expect(positionBetween(null, null)).toBe(1000);
    expect(positionBetween(1000, 2000)).toBe(1500);
    expect(positionBetween(null, 1000)).toBe(0);
    expect(positionBetween(1000, null)).toBe(2000);
  });
});
