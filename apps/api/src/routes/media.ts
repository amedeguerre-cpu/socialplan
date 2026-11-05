/** Panel için medya akışı (Access arkasında). Video önizleme Range destekler. */
import { Hono } from 'hono';
import { IMAGE_MIMES, VIDEO_MIMES } from '@socialplan/shared';
import { first } from '../lib/db';
import { notFound } from '../lib/errors';
import type { AppEnv } from '../types';

function parseRange(
  h: string | undefined,
  size: number,
): { offset: number; length: number } | null {
  const m = h ? /^bytes=(\d*)-(\d*)$/.exec(h.trim()) : null;
  if (!m) return null;
  let start = m[1] ? Number(m[1]) : NaN;
  let end = m[2] ? Number(m[2]) : NaN;
  if (Number.isNaN(start)) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (Number.isNaN(end) || end >= size) end = size - 1;
  if (start > end || start >= size) return null;
  return { offset: start, length: end - start + 1 };
}

/**
 * Sunulan tür izin listesinden seçilir (yüklenen nesnenin bildirdiği tür güvenilmez): video/* veya image/*;
 * aksi hâlde güvenli varsayılan. nosniff + sandbox CSP ile panel kökeninde betik çalıştırılamaz.
 */
export function safeContentType(
  stored: string | undefined,
  allowed: readonly string[],
  fallback: string,
): string {
  const t = (stored ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return allowed.includes(t) ? t : fallback;
}

async function serveObject(
  bucket: R2Bucket,
  key: string,
  allowed: readonly string[],
  fallbackType: string,
  rangeHeader?: string,
): Promise<Response> {
  const head = await bucket.head(key);
  if (!head) throw notFound('Dosya');
  const range = parseRange(rangeHeader, head.size);
  const obj = await bucket.get(key, range ? { range } : undefined);
  if (!obj) throw notFound('Dosya');
  const headers = new Headers({
    'content-type': safeContentType(head.httpMetadata?.contentType, allowed, fallbackType),
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'content-disposition': 'inline',
    'cache-control': 'private, max-age=86400',
    'accept-ranges': 'bytes',
    etag: head.httpEtag,
  });
  if (range) {
    headers.set(
      'content-range',
      `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
    );
    headers.set('content-length', String(range.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(head.size));
  return new Response(obj.body, { status: 200, headers });
}

export const mediaRoutes = new Hono<AppEnv>()
  .get('/thumb/:videoId', async (c) => {
    const r = await first<{ thumbnail_key: string | null }>(
      c.env.DB,
      'SELECT thumbnail_key FROM videos WHERE id = ?',
      c.req.param('videoId'),
    );
    if (!r?.thumbnail_key) throw notFound('Kapak');
    return serveObject(c.env.MEDIA, r.thumbnail_key, IMAGE_MIMES, 'image/jpeg');
  })
  .get('/video/:videoId', async (c) => {
    const r = await first<{ r2_key: string; mime: string }>(
      c.env.DB,
      'SELECT r2_key, mime FROM videos WHERE id = ? AND deleted_at IS NULL',
      c.req.param('videoId'),
    );
    if (!r) throw notFound('Video');
    return serveObject(
      c.env.MEDIA,
      r.r2_key,
      VIDEO_MIMES,
      safeContentType(r.mime, VIDEO_MIMES, 'application/octet-stream'),
      c.req.header('range'),
    );
  })
  .get('/avatar/:brandId', async (c) => {
    const r = await first<{ avatar_key: string | null }>(
      c.env.DB,
      'SELECT avatar_key FROM brands WHERE id = ?',
      c.req.param('brandId'),
    );
    if (!r?.avatar_key) throw notFound('Avatar');
    return serveObject(c.env.MEDIA, r.avatar_key, IMAGE_MIMES, 'image/jpeg');
  });
