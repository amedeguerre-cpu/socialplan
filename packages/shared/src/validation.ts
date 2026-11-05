import { PLATFORM_LABELS, PLATFORM_LIMITS, PLATFORMS, type Platform } from './platforms';

/** Tarayıcıda (mp4box + video elementi) okunan meta veri. Okunamayan alan null. */
export interface VideoMeta {
  mime: string;
  originalName: string;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioSampleRate?: number | null;
  bitrateKbps: number | null;
  moovAtStart: boolean | null;
}

export interface ValidationIssue {
  code: string;
  message: string;
  /** warning: yayını engellemez (ör. ölçülemeyen alan). */
  severity: 'error' | 'warning';
}

export interface PlatformValidation {
  ok: boolean;
  issues: ValidationIssue[];
}

export type ValidationResult = Record<Platform, PlatformValidation>;

const MB = 1024 * 1024;
const fmtMb = (b: number): string => `${Math.round(b / MB)} MB`;
const fmtSec = (s: number): string =>
  s >= 60 ? `${Math.round((s / 60) * 10) / 10} dk` : `${s} sn`;

/** Codec dizisini (avc1.64001f, hvc1…, mp4a.40.2) normalize eder. */
export function normalizeCodec(codec: string | null | undefined): string | null {
  if (!codec) return null;
  const c = codec.toLowerCase();
  if (c.startsWith('avc') || c === 'h264') return 'h264';
  if (c.startsWith('hvc') || c.startsWith('hev') || c === 'h265' || c === 'hevc') return 'hevc';
  if (c.startsWith('vp08') || c === 'vp8') return 'vp8';
  if (c.startsWith('vp09') || c === 'vp9') return 'vp9';
  if (c.startsWith('av01') || c === 'av1') return 'av1';
  if (c.startsWith('mp4a') || c === 'aac') return 'aac';
  if (c.startsWith('opus')) return 'opus';
  return c;
}

export function containerOf(meta: Pick<VideoMeta, 'mime' | 'originalName'>): string | null {
  const m = meta.mime.toLowerCase();
  if (m === 'video/mp4') return 'mp4';
  if (m === 'video/quicktime') return 'mov';
  if (m === 'video/webm') return 'webm';
  const ext = meta.originalName.toLowerCase().split('.').pop();
  return ext && ['mp4', 'mov', 'webm', 'm4v'].includes(ext) ? (ext === 'm4v' ? 'mp4' : ext) : null;
}

export function validateForPlatform(
  meta: VideoMeta,
  platform: Platform,
  overrides?: { maxDurationSec?: number },
): PlatformValidation {
  const L = PLATFORM_LIMITS[platform];
  const label = PLATFORM_LABELS[platform];
  const issues: ValidationIssue[] = [];
  const err = (code: string, message: string): void => {
    issues.push({ code, message: `${label}: ${message}`, severity: 'error' });
  };
  const warn = (code: string, message: string): void => {
    issues.push({ code, message: `${label}: ${message}`, severity: 'warning' });
  };

  const container = containerOf(meta);
  if (!container || !L.containers.value.includes(container)) {
    err(
      'container',
      `kapsayıcı ${container ?? 'bilinmiyor'}, desteklenen ${L.containers.value.join('/')}`,
    );
  }
  if (meta.sizeBytes > L.maxSizeBytes.value) {
    err('size', `dosya ${fmtMb(meta.sizeBytes)}, sınır ${fmtMb(L.maxSizeBytes.value)}`);
  }
  const vc = normalizeCodec(meta.videoCodec);
  if (vc === null) warn('video_codec_unknown', 'video codec okunamadı');
  else if (!L.videoCodecs.value.includes(vc)) {
    err('video_codec', `video codec ${vc}, desteklenen ${L.videoCodecs.value.join('/')}`);
  }
  if (L.audioCodecs) {
    const ac = normalizeCodec(meta.audioCodec);
    if (ac !== null && !L.audioCodecs.value.includes(ac)) {
      err('audio_codec', `ses codec ${ac}, desteklenen ${L.audioCodecs.value.join('/')}`);
    }
  }
  if (
    L.maxAudioSampleRateHz &&
    meta.audioSampleRate &&
    meta.audioSampleRate > L.maxAudioSampleRateHz.value
  ) {
    err(
      'audio_rate',
      `ses örnekleme ${meta.audioSampleRate} Hz, sınır ${L.maxAudioSampleRateHz.value} Hz`,
    );
  }
  if (L.fps) {
    if (meta.fps === null) warn('fps_unknown', 'fps okunamadı');
    else if (meta.fps < L.fps.value.min - 0.5 || meta.fps > L.fps.value.max + 0.5) {
      err('fps', `${Math.round(meta.fps)} fps, izin verilen ${L.fps.value.min}–${L.fps.value.max}`);
    }
  }
  const w = meta.width;
  const h = meta.height;
  if (w === null || h === null) {
    warn('dimensions_unknown', 'çözünürlük okunamadı');
  } else {
    if (L.maxWidth && w > L.maxWidth.value)
      err('width', `genişlik ${w} px, sınır ${L.maxWidth.value} px`);
    if (L.minEdge && Math.min(w, h) < L.minEdge.value) {
      err('min_edge', `kısa kenar ${Math.min(w, h)} px, en az ${L.minEdge.value} px`);
    }
    if (L.maxEdge && Math.max(w, h) > L.maxEdge.value) {
      err('max_edge', `uzun kenar ${Math.max(w, h)} px, en çok ${L.maxEdge.value} px`);
    }
    if (L.aspect) {
      const r = w / h;
      if (r < L.aspect.value.min || r > L.aspect.value.max)
        err('aspect', `en-boy oranı ${r.toFixed(2)} izin dışı`);
    }
    if (L.requireVertical?.value && w > h)
      err('vertical', `Shorts için dikey veya kare olmalı (${w}×${h})`);
  }
  if (L.maxBitrateKbps && meta.bitrateKbps !== null && meta.bitrateKbps > L.maxBitrateKbps.value) {
    err(
      'bitrate',
      `bit hızı ${Math.round(meta.bitrateKbps / 1000)} Mbps, sınır ${L.maxBitrateKbps.value / 1000} Mbps`,
    );
  }
  const maxDur = overrides?.maxDurationSec ?? L.durationSec.value.max;
  if (meta.durationMs === null) {
    err('duration_unknown', 'süre okunamadı');
  } else {
    const s = meta.durationMs / 1000;
    if (s < L.durationSec.value.min)
      err(
        'duration_min',
        `süre ${fmtSec(Math.round(s))}, en az ${fmtSec(L.durationSec.value.min)}`,
      );
    if (s > maxDur) err('duration_max', `süre ${fmtSec(Math.round(s))}, sınır ${fmtSec(maxDur)}`);
  }
  if (L.requireMoovAtStart?.value && meta.moovAtStart === false) {
    err('moov', 'moov atomu dosya başında değil (faststart ile yeniden kodlayın)');
  }
  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

export function validateVideo(meta: VideoMeta): ValidationResult {
  const out = {} as ValidationResult;
  for (const p of PLATFORMS) out[p] = validateForPlatform(meta, p);
  return out;
}
