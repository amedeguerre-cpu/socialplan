/** Tarayıcıdan R2'ye presigned multipart yükleme: 3–4 paralel PUT, parça başına yeniden deneme, ilerleme. */
import type { VideoDTO, VideoMeta } from '@socialplan/shared';
import { api } from './api';

export interface UploadInitResponse {
  video_id: string;
  part_size: number;
  parts: { partNumber: number; url: string }[];
  thumbnail_url: string;
  direct: boolean;
  duplicate_warning: string | null;
}

export interface UploadOptions {
  brandId: string;
  file: File;
  meta: VideoMeta;
  contentHash?: string;
  title?: string;
  description?: string;
  aiGenerated: boolean;
  madeForKids?: boolean;
  thumbnail?: Blob | null;
  concurrency?: number;
  onProgress?: (loaded: number, total: number) => void;
  onInit?: (init: UploadInitResponse) => void;
  signal?: AbortSignal;
}

function putWithProgress(
  url: string,
  body: Blob,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
  contentType?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    if (contentType) xhr.setRequestHeader('content-type', contentType);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300)
        resolve((xhr.getResponseHeader('ETag') ?? '').replace(/"/g, ''));
      else reject(new Error(`PUT ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Ağ hatası'));
    xhr.onabort = () => reject(new DOMException('İptal edildi', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseMs = 800,
  signal?: AbortSignal,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) throw e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw last;
}

/** Eşzamanlılık sınırlı havuz. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function uploadVideoFile(o: UploadOptions): Promise<VideoDTO> {
  const init = await api.post<UploadInitResponse>('/uploads', {
    brand_id: o.brandId,
    original_name: o.file.name,
    mime: o.meta.mime,
    size_bytes: o.file.size,
    content_hash: o.contentHash,
  });
  o.onInit?.(init);
  const loaded = new Map<number, number>();
  const report = () =>
    o.onProgress?.(
      [...loaded.values()].reduce((a, b) => a + b, 0),
      o.file.size,
    );
  try {
    const etags = await pool(init.parts, o.concurrency ?? 4, (p) =>
      withRetry(
        () => {
          const blob = o.file.slice(
            (p.partNumber - 1) * init.part_size,
            p.partNumber * init.part_size,
          );
          return putWithProgress(
            p.url,
            blob,
            (n) => {
              loaded.set(p.partNumber, n);
              report();
            },
            o.signal,
          );
        },
        3,
        800,
        o.signal,
      ).then((etag) => ({ partNumber: p.partNumber, etag })),
    );
    let thumbnail = false;
    if (o.thumbnail) {
      try {
        await withRetry(() =>
          putWithProgress(
            init.thumbnail_url,
            o.thumbnail as Blob,
            () => undefined,
            o.signal,
            'image/jpeg',
          ),
        );
        thumbnail = true;
      } catch {
        /* kapak olmadan da devam */
      }
    }
    return await api.post<VideoDTO>(`/uploads/${init.video_id}/complete`, {
      parts: etags,
      meta: o.meta,
      title: o.title,
      description: o.description,
      ai_generated: o.aiGenerated,
      made_for_kids: o.madeForKids ?? false,
      thumbnail,
    });
  } catch (e) {
    await api.post(`/uploads/${init.video_id}/abort`).catch(() => undefined);
    throw e;
  }
}

export async function uploadThumbnail(videoId: string, blob: Blob): Promise<void> {
  const { url } = await api.post<{ url: string }>(`/videos/${videoId}/thumbnail`);
  await withRetry(() => putWithProgress(url, blob, () => undefined, undefined, 'image/jpeg'));
}
