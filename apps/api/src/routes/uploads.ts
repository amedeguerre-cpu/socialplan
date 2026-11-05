/**
 * Tarayıcıdan doğrudan R2'ye presigned multipart yükleme (video Worker'dan geçmez).
 * Yerelde (S3 anahtarı yokken) parça PUT'ları /api/uploads/local/* ile binding'e yazılır.
 */
import { Hono } from 'hono';
import { IMAGE_MIMES } from '@socialplan/shared';
import { safeContentType } from './media';
import {
  uploadCompleteSchema,
  uploadInitSchema,
  validateVideo,
  type VideoDTO,
  type ValidationResult,
} from '@socialplan/shared';
import { b2i, first, newId, nowIso, run } from '../lib/db';
import { toVideoDTO } from '../lib/dto';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors';
import { audit } from '../lib/audit';
import {
  hasS3Credentials,
  PART_SIZE,
  presignPut,
  presignUploadPart,
  thumbKey,
  verifyLocalToken,
  videoKey,
} from '../lib/r2';
import { v } from '../lib/validate';
import type { VideoRow } from '../lib/rows';
import type { AppEnv } from '../types';
import { duplicateWarning, nextQueuePosition } from '../lib/videos';

export const uploadRoutes = new Hono<AppEnv>()
  .post('/', v('json', uploadInitSchema), async (c) => {
    const body = c.req.valid('json');
    const brand = await first(c.env.DB, 'SELECT id FROM brands WHERE id = ?', body.brand_id);
    if (!brand) throw notFound('Marka');
    const id = newId();
    const key = videoKey(body.brand_id, id, body.original_name);
    const mpu = await c.env.MEDIA.createMultipartUpload(key, {
      httpMetadata: { contentType: body.mime },
    });
    const at = nowIso();
    await run(
      c.env.DB,
      `INSERT INTO videos (id, brand_id, r2_key, original_name, mime, size_bytes, content_hash, status, multipart_upload_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?, ?)`,
      id,
      body.brand_id,
      key,
      body.original_name,
      body.mime,
      body.size_bytes,
      body.content_hash ?? null,
      mpu.uploadId,
      c.get('actor'),
      at,
      at,
    );
    const count = Math.max(1, Math.ceil(body.size_bytes / PART_SIZE));
    if (count > 10000) throw badRequest('Dosya çok büyük (en çok 10.000 parça)');
    const parts = await Promise.all(
      Array.from({ length: count }, async (_, i) => ({
        partNumber: i + 1,
        url: await presignUploadPart(c.env, id, key, mpu.uploadId, i + 1),
      })),
    );
    const thumbnailUrl = await presignPut(c.env, thumbKey(body.brand_id, id));
    return c.json(
      {
        video_id: id,
        part_size: PART_SIZE,
        parts,
        thumbnail_url: thumbnailUrl,
        direct: hasS3Credentials(c.env),
        duplicate_warning: await duplicateWarning(c.env.DB, body.content_hash, body.brand_id, id),
      },
      201,
    );
  })
  .put('/local/:videoId/parts/:n', async (c) => {
    if (hasS3Credentials(c.env)) throw notFound('Uç');
    const videoId = c.req.param('videoId');
    const n = Number(c.req.param('n'));
    const ok = await verifyLocalToken(
      c.env,
      `part:${videoId}:${n}`,
      c.req.query('t') ?? '',
      Number(c.req.query('exp')),
    );
    if (!ok) throw new HttpError(403, 'bad_token', 'Geçersiz yükleme imzası');
    const vrow = await first<VideoRow>(c.env.DB, 'SELECT * FROM videos WHERE id = ?', videoId);
    if (!vrow?.multipart_upload_id) throw notFound('Yükleme');
    const mpu = c.env.MEDIA.resumeMultipartUpload(vrow.r2_key, vrow.multipart_upload_id);
    const part = await mpu.uploadPart(n, await c.req.arrayBuffer());
    return c.body(null, 200, { ETag: part.etag, 'Access-Control-Expose-Headers': 'ETag' });
  })
  .put('/local/object', async (c) => {
    if (hasS3Credentials(c.env)) throw notFound('Uç');
    const key = c.req.query('key') ?? '';
    const ok = await verifyLocalToken(
      c.env,
      `put:${key}`,
      c.req.query('t') ?? '',
      Number(c.req.query('exp')),
    );
    if (!ok) throw new HttpError(403, 'bad_token', 'Geçersiz yükleme imzası');
    const obj = await c.env.MEDIA.put(key, await c.req.arrayBuffer(), {
      httpMetadata: {
        contentType: safeContentType(c.req.header('content-type'), IMAGE_MIMES, 'image/jpeg'),
      },
    });
    return c.body(null, 200, { ETag: obj?.httpEtag ?? '' });
  })
  .post('/:id/complete', v('json', uploadCompleteSchema), async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const vrow = await first<VideoRow>(c.env.DB, 'SELECT * FROM videos WHERE id = ?', id);
    if (!vrow) throw notFound('Video');
    if (vrow.status !== 'uploading' || !vrow.multipart_upload_id)
      throw conflict('Yükleme zaten tamamlanmış');
    const mpu = c.env.MEDIA.resumeMultipartUpload(vrow.r2_key, vrow.multipart_upload_id);
    const sorted = [...body.parts].sort((a, b) => a.partNumber - b.partNumber);
    let obj: R2Object;
    try {
      obj = await mpu.complete(
        sorted.map((p) => ({ partNumber: p.partNumber, etag: p.etag.replace(/"/g, '') })),
      );
    } catch (e) {
      throw badRequest(
        `Yükleme tamamlanamadı: ${e instanceof Error ? e.message : String(e)}`,
        'complete_failed',
      );
    }
    const meta = { ...body.meta, sizeBytes: obj.size };
    const validation: ValidationResult = validateVideo(meta);
    const anyOk = Object.values(validation).some((r) => r.ok);
    const at = nowIso();
    await run(
      c.env.DB,
      `UPDATE videos SET status = ?, size_bytes = ?, duration_ms = ?, width = ?, height = ?, fps = ?, video_codec = ?, audio_codec = ?,
         bitrate_kbps = ?, moov_at_start = ?, title = ?, description = ?, ai_generated = ?, made_for_kids = ?, validation = ?,
         thumbnail_key = ?, multipart_upload_id = NULL, queue_position = ?, updated_at = ? WHERE id = ?`,
      anyOk ? 'ready' : 'invalid',
      obj.size,
      meta.durationMs,
      meta.width,
      meta.height,
      meta.fps,
      meta.videoCodec,
      meta.audioCodec,
      meta.bitrateKbps,
      meta.moovAtStart === null ? null : b2i(meta.moovAtStart),
      body.title ?? vrow.original_name.replace(/\.[^.]+$/, ''),
      body.description ?? '',
      b2i(body.ai_generated),
      b2i(body.made_for_kids ?? false),
      JSON.stringify(validation),
      body.thumbnail ? thumbKey(vrow.brand_id, id) : null,
      await nextQueuePosition(c.env.DB, vrow.brand_id),
      at,
      id,
    );
    await audit(c.env.DB, c.get('actor'), 'video.upload', 'video', id, {
      name: vrow.original_name,
      size: obj.size,
    });
    const r = (await first<VideoRow>(
      c.env.DB,
      'SELECT * FROM videos WHERE id = ?',
      id,
    )) as VideoRow;
    return c.json<VideoDTO>(
      toVideoDTO(r, await duplicateWarning(c.env.DB, r.content_hash, r.brand_id, r.id)),
    );
  })
  .post('/:id/abort', async (c) => {
    const id = c.req.param('id');
    const vrow = await first<VideoRow>(c.env.DB, 'SELECT * FROM videos WHERE id = ?', id);
    if (!vrow) throw notFound('Video');
    if (vrow.status !== 'uploading') throw conflict('Yükleme devam etmiyor');
    if (vrow.multipart_upload_id) {
      try {
        await c.env.MEDIA.resumeMultipartUpload(vrow.r2_key, vrow.multipart_upload_id).abort();
      } catch {
        /* zaten düşmüş olabilir; R2 lifecycle yarım yüklemeleri temizler */
      }
    }
    await run(
      c.env.DB,
      "UPDATE videos SET status = 'archived', deleted_at = ?, multipart_upload_id = NULL, updated_at = ? WHERE id = ?",
      nowIso(),
      nowIso(),
      id,
    );
    return c.json({ ok: true });
  });
