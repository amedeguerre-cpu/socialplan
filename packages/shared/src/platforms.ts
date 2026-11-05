export const PLATFORMS = ['instagram', 'youtube', 'tiktok'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: 'Instagram',
  youtube: 'YouTube',
  tiktok: 'TikTok',
};

/** Hesap çalışma modu: TikTok her zaman 'inbox' (taslağa gönder). */
export type AccountMode = 'auto' | 'inbox';
export const DEFAULT_MODE: Record<Platform, AccountMode> = {
  instagram: 'auto',
  youtube: 'auto',
  tiktok: 'inbox',
};

/**
 * Platform limit tablosu. Her satır kaynak URL ve doğrulama tarihi taşır.
 * Doğrulama: 31.10–05.11.2026, resmi doküman sitelerine erişim olmadığından arama özetleriyle.
 * Kesinleşmeyen değerler `verified: false` ve CLAUDE.md'deki TODO(doğrula) listesinde.
 */
export interface LimitRow<T> {
  value: T;
  source: string;
  checkedAt: string;
  verified: boolean;
  note?: string;
}

const IG_REELS_SPEC =
  'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media#reels-specifications';
const TT_VIDEO_SPEC =
  'https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide#video_restrictions';
const YT_SHORTS = 'https://support.google.com/youtube/answer/10059070';
const CHECKED = '2026-11-05';

export interface PlatformLimits {
  containers: LimitRow<string[]>;
  videoCodecs: LimitRow<string[]>;
  audioCodecs: LimitRow<string[]> | null;
  maxAudioSampleRateHz: LimitRow<number> | null;
  fps: LimitRow<{ min: number; max: number }> | null;
  maxWidth: LimitRow<number> | null;
  minEdge: LimitRow<number> | null;
  maxEdge: LimitRow<number> | null;
  maxBitrateKbps: LimitRow<number> | null;
  durationSec: LimitRow<{ min: number; max: number }>;
  maxSizeBytes: LimitRow<number>;
  aspect: LimitRow<{ min: number; max: number }> | null;
  requireVertical: LimitRow<boolean> | null;
  requireMoovAtStart: LimitRow<boolean> | null;
}

const MB = 1024 * 1024;

export const PLATFORM_LIMITS: Record<Platform, PlatformLimits> = {
  instagram: {
    containers: {
      value: ['mp4', 'mov'],
      source: IG_REELS_SPEC,
      checkedAt: CHECKED,
      verified: true,
    },
    videoCodecs: {
      value: ['h264', 'hevc'],
      source: IG_REELS_SPEC,
      checkedAt: CHECKED,
      verified: true,
    },
    audioCodecs: { value: ['aac'], source: IG_REELS_SPEC, checkedAt: CHECKED, verified: true },
    maxAudioSampleRateHz: {
      value: 48000,
      source: IG_REELS_SPEC,
      checkedAt: CHECKED,
      verified: true,
    },
    fps: { value: { min: 23, max: 60 }, source: IG_REELS_SPEC, checkedAt: CHECKED, verified: true },
    maxWidth: { value: 1920, source: IG_REELS_SPEC, checkedAt: CHECKED, verified: true },
    minEdge: null,
    maxEdge: null,
    maxBitrateKbps: { value: 25000, source: IG_REELS_SPEC, checkedAt: CHECKED, verified: true },
    durationSec: {
      value: { min: 3, max: 900 },
      source: IG_REELS_SPEC,
      checkedAt: CHECKED,
      verified: true,
    },
    maxSizeBytes: { value: 300 * MB, source: IG_REELS_SPEC, checkedAt: CHECKED, verified: true },
    aspect: {
      value: { min: 0.01, max: 10 },
      source: IG_REELS_SPEC,
      checkedAt: CHECKED,
      verified: true,
      note: '9:16 önerilir',
    },
    requireVertical: null,
    requireMoovAtStart: { value: true, source: IG_REELS_SPEC, checkedAt: CHECKED, verified: true },
  },
  tiktok: {
    containers: {
      value: ['mp4', 'webm', 'mov'],
      source: TT_VIDEO_SPEC,
      checkedAt: CHECKED,
      verified: true,
    },
    videoCodecs: {
      value: ['h264', 'hevc', 'vp8', 'vp9'],
      source: TT_VIDEO_SPEC,
      checkedAt: CHECKED,
      verified: true,
    },
    audioCodecs: null,
    maxAudioSampleRateHz: null,
    fps: { value: { min: 23, max: 60 }, source: TT_VIDEO_SPEC, checkedAt: CHECKED, verified: true },
    maxWidth: null,
    minEdge: { value: 360, source: TT_VIDEO_SPEC, checkedAt: CHECKED, verified: true },
    maxEdge: { value: 4096, source: TT_VIDEO_SPEC, checkedAt: CHECKED, verified: true },
    maxBitrateKbps: null,
    durationSec: {
      value: { min: 1, max: 600 },
      source: TT_VIDEO_SPEC,
      checkedAt: CHECKED,
      verified: false,
      note: 'Gerçek üst sınır hesap bazında creator_info.max_video_post_duration_sec; burada varsayılan 10 dk. TODO(doğrula)',
    },
    maxSizeBytes: { value: 4096 * MB, source: TT_VIDEO_SPEC, checkedAt: CHECKED, verified: true },
    aspect: null,
    requireVertical: null,
    requireMoovAtStart: null,
  },
  youtube: {
    containers: {
      value: ['mp4', 'mov', 'webm'],
      source: 'https://support.google.com/youtube/answer/4603579',
      checkedAt: CHECKED,
      verified: true,
    },
    videoCodecs: {
      value: ['h264', 'hevc', 'vp8', 'vp9', 'av1'],
      source: 'https://support.google.com/youtube/answer/1722171',
      checkedAt: CHECKED,
      verified: true,
    },
    audioCodecs: null,
    maxAudioSampleRateHz: null,
    fps: null,
    maxWidth: null,
    minEdge: null,
    maxEdge: null,
    maxBitrateKbps: null,
    durationSec: {
      value: { min: 1, max: 180 },
      source: YT_SHORTS,
      checkedAt: CHECKED,
      verified: true,
      note: 'Shorts: API bayrağı yok; dikey/kare ve ≤ 3 dk',
    },
    maxSizeBytes: {
      value: 256 * 1024 * MB,
      source: 'https://developers.google.com/youtube/v3/docs/videos/insert',
      checkedAt: CHECKED,
      verified: true,
    },
    aspect: null,
    requireVertical: {
      value: true,
      source: YT_SHORTS,
      checkedAt: CHECKED,
      verified: true,
      note: 'dikey veya kare',
    },
    requireMoovAtStart: null,
  },
};

/** Kota/limit sabitleri (sabit yazılmaması gerekenler ayrıca API'den okunur). */
export const QUOTAS = {
  youtube: {
    uploadsPerDay: {
      value: 100,
      source: 'https://developers.google.com/youtube/v3/determine_quota_cost',
      checkedAt: CHECKED,
      verified: false,
      note: 'Haziran 2026 ayrı yükleme kovası; TODO(doğrula)',
    },
    unitsPerDay: {
      value: 10000,
      source: 'https://developers.google.com/youtube/v3/determine_quota_cost',
      checkedAt: CHECKED,
      verified: true,
    },
    resetTimeZone: 'America/Los_Angeles',
  },
  instagram: {
    note: 'Yayın limiti rehberde 100, referansta 50: sabit yazılmaz, content_publishing_limit ile okunur.',
  },
} as const;
