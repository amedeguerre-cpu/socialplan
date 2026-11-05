import { Hono } from 'hono';
import {
  positionBetween,
  reorderSchema,
  videoUpdateSchema,
  type PostDTO,
  type VideoDTO,
} from '@socialplan/shared';
import { all, b2i, first, nowIso, run } from '../lib/db';
import { toPostDTO, toVideoDTO } from '../lib/dto';
import { badRequest, conflict, notFound } from '../lib/errors';
import { audit } from '../lib/audit';
import { presignPut, thumbKey } from '../lib/r2';
import { v } from '../lib/validate';
import { duplicateWarning, nextQueuePosition } from '../lib/videos';
import type { PostRow, VideoRow } from '../lib/rows';
import type { AppEnv } from '../types';

async function getVideo(db: D1Database, id: string): Promise<VideoRow> {
  const r = await first<VideoRow>(
    db,
    'SELECT * FROM videos WHERE id = ? AND deleted_at IS NULL',
    id,
  );
  if (!r) throw notFound('Video');
  return r;
}

const ACTIVE_POST = "('scheduled','processing','inbox_sent')";

export const videoRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const brandId = c.req.query('brand_id');
    const status = c.req.query('status');
    if (!brandId) throw badRequest('brand_id gerekli');
    let sql = 'SELECT * FROM videos WHERE brand_id = ? AND deleted_at IS NULL';
    const params: string[] = [brandId];
    if (status === 'queue') sql += " AND status = 'ready'";
    else if (status) {
      sql += ' AND status = ?';
      params.push(status);
    } else sql += " AND status <> 'archived'";
    sql += ' ORDER BY queue_position ASC, created_at ASC LIMIT 500';
    const rows = await all<VideoRow>(c.env.DB, sql, ...params);
    return c.json<VideoDTO[]>(rows.map((r) => toVideoDTO(r)));
  })
  .get('/:id', async (c) => {
    const r = await getVideo(c.env.DB, c.req.param('id'));
    return c.json<VideoDTO>(
      toVideoDTO(r, await duplicateWarning(c.env.DB, r.content_hash, r.brand_id, r.id)),
    );
  })
  .get('/:id/posts', async (c) => {
    const rows = await all<
      PostRow & { video_title: string; thumbnail_key: string | null; video_updated_at: string }
    >(
      c.env.DB,
      `SELECT p.*, v.title AS video_title, v.thumbnail_key, v.updated_at AS video_updated_at FROM posts p JOIN videos v ON v.id = p.video_id
       WHERE p.video_id = ? ORDER BY p.scheduled_at`,
      c.req.param('id'),
    );
    return c.json<PostDTO[]>(rows.map(toPostDTO));
  })
  .patch('/:id', v('json', videoUpdateSchema), async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const cur = await getVideo(c.env.DB, id);
    if (body.status === 'ready' && cur.status !== 'archived')
      throw badRequest('Yalnız arşivlenmiş video yeniden kuyruğa alınabilir');
    if (body.status === 'archived') {
      const active = await first(
        c.env.DB,
        `SELECT id FROM posts WHERE video_id = ? AND status IN ${ACTIVE_POST} LIMIT 1`,
        id,
      );
      if (active)
        throw conflict('Videonun planlanmış paylaşımları var; önce iptal edin', 'has_active_posts');
    }
    const tags = body.hashtags?.map((t) => t.replace(/^#/, ''));
    await run(
      c.env.DB,
      `UPDATE videos SET title = ?, description = ?, hashtags = ?, caption_overrides = ?, ai_generated = ?, made_for_kids = ?, status = ?, updated_at = ? WHERE id = ?`,
      body.title ?? cur.title,
      body.description ?? cur.description,
      tags ? JSON.stringify(tags) : cur.hashtags,
      body.caption_overrides ? JSON.stringify(body.caption_overrides) : cur.caption_overrides,
      body.ai_generated === undefined ? cur.ai_generated : b2i(body.ai_generated),
      body.made_for_kids === undefined ? cur.made_for_kids : b2i(body.made_for_kids),
      body.status ?? cur.status,
      nowIso(),
      id,
    );
    if (body.status === 'ready') {
      await run(
        c.env.DB,
        'UPDATE videos SET queue_position = ? WHERE id = ?',
        await nextQueuePosition(c.env.DB, cur.brand_id),
        id,
      );
    }
    await audit(c.env.DB, c.get('actor'), 'video.update', 'video', id, {
      fields: Object.keys(body),
    });
    return c.json<VideoDTO>(toVideoDTO(await getVideo(c.env.DB, id)));
  })
  .post('/:id/reorder', v('json', reorderSchema), async (c) => {
    const id = c.req.param('id');
    const { before_id, after_id } = c.req.valid('json');
    const cur = await getVideo(c.env.DB, id);
    const pos = async (vid: string | null): Promise<number | null> => {
      if (!vid) return null;
      const r = await first<{ queue_position: number; brand_id: string }>(
        c.env.DB,
        'SELECT queue_position, brand_id FROM videos WHERE id = ?',
        vid,
      );
      if (!r || r.brand_id !== cur.brand_id) throw badRequest('Komşu video bulunamadı');
      return r.queue_position;
    };
    const p = positionBetween(await pos(before_id), await pos(after_id));
    await run(
      c.env.DB,
      'UPDATE videos SET queue_position = ?, updated_at = ? WHERE id = ?',
      p,
      nowIso(),
      id,
    );
    return c.json({ id, queue_position: p });
  })
  .post('/:id/thumbnail', async (c) => {
    const cur = await getVideo(c.env.DB, c.req.param('id'));
    const key = thumbKey(cur.brand_id, cur.id);
    const url = await presignPut(c.env, key);
    await run(
      c.env.DB,
      'UPDATE videos SET thumbnail_key = ?, updated_at = ? WHERE id = ?',
      key,
      nowIso(),
      cur.id,
    );
    return c.json({ url });
  })
  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    const cur = await getVideo(c.env.DB, id);
    const active = await first(
      c.env.DB,
      `SELECT id FROM posts WHERE video_id = ? AND status IN ${ACTIVE_POST} LIMIT 1`,
      id,
    );
    if (active)
      throw conflict('Videonun planlanmış paylaşımları var; önce iptal edin', 'has_active_posts');
    await c.env.MEDIA.delete(cur.r2_key);
    await run(
      c.env.DB,
      "UPDATE videos SET status = 'archived', deleted_at = ?, updated_at = ? WHERE id = ?",
      nowIso(),
      nowIso(),
      id,
    );
    await audit(c.env.DB, c.get('actor'), 'video.delete', 'video', id, { name: cur.original_name });
    return c.json({ ok: true });
  });
