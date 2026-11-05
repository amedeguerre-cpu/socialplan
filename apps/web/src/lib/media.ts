/**
 * Tarayıcıda video meta verisi: mp4box.js ile codec/fps/bit hızı/ses örnekleme, en üst kutu taramasıyla
 * moov konumu, video elementiyle süre/en/boy, canvas ile thumbnail. Hiçbir veri sunucuya gitmeden okunur.
 */
import { createFile, MP4BoxBuffer, type Movie } from 'mp4box';
import type { VideoMeta } from '@socialplan/shared';

export interface TopBox {
  type: string;
  offset: number;
  size: number;
}

export type ReadAt = (offset: number, length: number) => Promise<ArrayBuffer>;

/** ISO BMFF en üst seviye kutuları (ftyp, moov, mdat…) — yalnız başlıkları okur. */
export async function scanTopLevelBoxes(
  readAt: ReadAt,
  fileSize: number,
  maxBoxes = 64,
): Promise<TopBox[]> {
  const boxes: TopBox[] = [];
  let offset = 0;
  while (offset + 8 <= fileSize && boxes.length < maxBoxes) {
    const head = new DataView(await readAt(offset, 16));
    let size = head.getUint32(0);
    const type = String.fromCharCode(
      head.getUint8(4),
      head.getUint8(5),
      head.getUint8(6),
      head.getUint8(7),
    );
    if (!/^[\x20-\x7e]{4}$/.test(type)) break;
    if (size === 1) {
      if (head.byteLength < 16) break;
      size = Number(head.getBigUint64(8));
    } else if (size === 0) {
      size = fileSize - offset;
    }
    if (size < 8) break;
    boxes.push({ type, offset, size });
    offset += size;
  }
  return boxes;
}

/** moov, mdat'tan önce mi? (faststart) Kutular bulunamazsa null. */
export function moovAtStart(boxes: TopBox[]): boolean | null {
  const moov = boxes.findIndex((b) => b.type === 'moov');
  const mdat = boxes.findIndex((b) => b.type === 'mdat');
  if (moov < 0 || mdat < 0) return null;
  return moov < mdat;
}

export function fileReader(file: Blob): ReadAt {
  return async (offset, length) =>
    file.slice(offset, Math.min(offset + length, file.size)).arrayBuffer();
}

export interface Mp4Info {
  videoCodec: string | null;
  audioCodec: string | null;
  audioSampleRate: number | null;
  fps: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

export function infoFromMovie(info: Movie): Mp4Info {
  const vt = info.videoTracks[0];
  const at = info.audioTracks[0];
  const vDur = vt && vt.timescale ? vt.duration / vt.timescale : null;
  return {
    videoCodec: vt?.codec ?? null,
    audioCodec: at?.codec ?? null,
    audioSampleRate: at?.audio?.sample_rate ?? null,
    fps: vt && vDur ? Math.round((vt.nb_samples / vDur) * 100) / 100 : null,
    durationMs: info.timescale ? Math.round((info.duration / info.timescale) * 1000) : null,
    width: vt?.video?.width ?? vt?.track_width ?? null,
    height: vt?.video?.height ?? vt?.track_height ?? null,
  };
}

async function parseMp4(file: Blob, boxes: TopBox[]): Promise<Mp4Info | null> {
  const moovIdx = boxes.findIndex((b) => b.type === 'moov');
  const moov = boxes[moovIdx];
  if (!moov || moov.size > 64 * 1024 * 1024) return null;
  return new Promise((resolve) => {
    const mp4 = createFile();
    let done = false;
    mp4.onReady = (info: Movie) => {
      done = true;
      resolve(infoFromMovie(info));
    };
    mp4.onError = () => {
      if (!done) resolve(null);
    };
    (async () => {
      // Kutular sırayla beslenir; mdat'ın yalnız başlığı (moov sonda olsa bile tüm dosya okunmaz).
      for (const b of boxes.slice(0, moovIdx + 1)) {
        const len = b.type === 'mdat' ? 16 : b.size;
        if (b.type !== 'mdat' && b.type !== 'moov' && len > 4 * 1024 * 1024) return resolve(null);
        const ab = await file.slice(b.offset, b.offset + len).arrayBuffer();
        mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, b.offset));
        if (done) return;
      }
      mp4.flush();
      if (!done) resolve(null);
    })().catch(() => resolve(null));
  });
}

function elementInfo(
  file: Blob,
): Promise<{ durationMs: number | null; width: number | null; height: number | null }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const finish = (r: {
      durationMs: number | null;
      width: number | null;
      height: number | null;
    }) => {
      URL.revokeObjectURL(url);
      resolve(r);
    };
    v.onloadedmetadata = () =>
      finish({
        durationMs: Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : null,
        width: v.videoWidth || null,
        height: v.videoHeight || null,
      });
    v.onerror = () => finish({ durationMs: null, width: null, height: null });
    v.src = url;
  });
}

export async function probeVideo(file: File): Promise<VideoMeta> {
  const isIso = /\.(mp4|mov|m4v)$/i.test(file.name) || /mp4|quicktime/.test(file.type);
  const boxes = isIso ? await scanTopLevelBoxes(fileReader(file), file.size).catch(() => []) : [];
  const mp4 = isIso ? await parseMp4(file, boxes) : null;
  const el = await elementInfo(file);
  const durationMs = el.durationMs ?? mp4?.durationMs ?? null;
  return {
    mime: file.type || (file.name.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4'),
    originalName: file.name,
    sizeBytes: file.size,
    durationMs,
    width: el.width ?? mp4?.width ?? null,
    height: el.height ?? mp4?.height ?? null,
    fps: mp4?.fps ?? null,
    videoCodec: mp4?.videoCodec ?? null,
    audioCodec: mp4?.audioCodec ?? null,
    audioSampleRate: mp4?.audioSampleRate ?? null,
    bitrateKbps: durationMs ? Math.round((file.size * 8) / (durationMs / 1000) / 1000) : null,
    moovAtStart: isIso ? moovAtStart(boxes) : null,
  };
}

/** Thumbnail boyutu: uzun kenar en çok `max` px, oran korunur. */
export function thumbSize(w: number, h: number, max = 720): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: max, height: max };
  const s = Math.min(1, max / Math.max(w, h));
  return { width: Math.round(w * s), height: Math.round(h * s) };
}

/** Belirtilen saniyedeki kareyi JPEG olarak yakalar. */
export function captureFrame(src: Blob | string, atSec: number, max = 720): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = typeof src === 'string' ? src : URL.createObjectURL(src);
    const v = document.createElement('video');
    v.preload = 'auto';
    v.muted = true;
    v.crossOrigin = 'use-credentials';
    v.playsInline = true;
    const cleanup = () => {
      if (typeof src !== 'string') URL.revokeObjectURL(url);
    };
    v.onloadedmetadata = () => {
      v.currentTime = Math.min(Math.max(0, atSec), Math.max(0, (v.duration || 0) - 0.1));
    };
    v.onseeked = () => {
      const { width, height } = thumbSize(v.videoWidth, v.videoHeight, max);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        cleanup();
        reject(new Error('Canvas desteklenmiyor'));
        return;
      }
      ctx.drawImage(v, 0, 0, width, height);
      canvas.toBlob(
        (b) => {
          cleanup();
          if (b) resolve(b);
          else reject(new Error('Kare yakalanamadı'));
        },
        'image/jpeg',
        0.85,
      );
    };
    v.onerror = () => {
      cleanup();
      reject(new Error('Video okunamadı'));
    };
    v.src = url;
  });
}

/**
 * İçerik özeti: SHA-256(boyut + baş/orta/son 4 MiB). Çok GB'lık dosyada tam özet yerine örneklemeli —
 * yinelenen yükleme uyarısı için yeterli.
 */
export async function sampledHash(file: Blob): Promise<string> {
  const S = 4 * 1024 * 1024;
  const parts: BlobPart[] = [new TextEncoder().encode(String(file.size))];
  if (file.size <= 3 * S) parts.push(file);
  else {
    const mid = Math.floor(file.size / 2 - S / 2);
    parts.push(file.slice(0, S), file.slice(mid, mid + S), file.slice(file.size - S));
  }
  const buf = await new Blob(parts).arrayBuffer();
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
