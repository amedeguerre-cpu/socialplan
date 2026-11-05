import { Hono } from 'hono';
import {
  bulkPostsSchema,
  canTransition,
  fillSchema,
  manualScheduleSchema,
  markPublishedSchema,
  postListQuerySchema,
  postUpdateSchema,
  zonedToUtc,
  type Paged,
  type PostDTO,
  type PostEventDTO,
  type PostStatus,
  type ValidationResult,
} from '@socialplan/shared';
import { all, first, newId, nowIso, parseJson, type SqlValue } from '../lib/db';
import { toPostDTO } from '../lib/dto';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors';
import { audit } from '../lib/audit';
import { acquireLease, eventStmt, humanTransition, syncVideoStatusStmt } from '../lib/posts';
import { v } from '../lib/validate';
import type { AccountRow, BrandRow, PostRow, VideoRow } from '../lib/rows';
import { getSettings } from '../lib/settings';
import {
  captionFor,
  fillQueue,
  hashUsedOnAccount,
  insertPostStmt,
  type PlannedPost,
} from '../scheduler/fill';
import { enqueue } from '../publish/orchestrator';
import { createHttp } from '../publish/http';
import { makeYoutubePublic } from '../publish/youtube';
import { PlatformHttpError } from '../publish/errors';
import { readTokens } from '../lib/tokens';
import type { AppEnv } from '../types';

type PostJoined = PostRow & {
  video_title: string | null;
  thumbnail_key: string | null;
  video_updated_at: string | null;
};
const SELECT_JOINED = `SELECT p.*, v.title AS video_title, v.thumbnail_key, v.updated_at AS video_updated_at FROM posts p JOIN videos v ON v.id = p.video_id`;

async function getPost(db: D1Database, id: string): Promise<PostRow> {
  const r = await first<PostRow>(db, 'SELECT * FROM posts WHERE id = ?', id);
  if (!r) throw notFound('Paylaşım');
  return r;
}
async function getJoined(db: D1Database, id: string): Promise<PostDTO> {
  const r = await first<PostJoined>(db, `${SELECT_JOINED} WHERE p.id = ?`, id);
  if (!r) throw notFound('Paylaşım');
  return toPostDTO(r);
}

function invalidTransition(from: PostStatus, to: PostStatus): HttpError {
  return conflict(`Bu durumdaki paylaşım için yapılamaz (${from} → ${to})`, 'invalid_transition');
}

/** Hemen kuyruğa al: scheduled_at=now, kilitle, mesaj gönder. */
async function dispatchNow(env: AppEnv['Bindings'], postId: string, now: Date): Promise<boolean> {
  const p = await getPost(env.DB, postId);
  const owner = `now:${newId()}`;
  if (!(await acquireLease(env.DB, postId, owner, now))) return false;
  await eventStmt(env.DB, p, 'scheduled', 'processing', null, { by: 'publish_now' }, now).run();
  await enqueue(env, { postId, traceId: p.trace_id, leaseOwner: owner });
  return true;
}

export const postRoutes = new Hono<AppEnv>()
  .get('/', v('query', postListQuerySchema), async (c) => {
    const q = c.req.valid('query');
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (q.brand_id) {
      where.push('p.brand_id = ?');
      params.push(q.brand_id);
    }
    if (q.platform) {
      where.push('p.platform = ?');
      params.push(q.platform);
    }
    if (q.status) {
      where.push('p.status = ?');
      params.push(q.status);
    }
    if (q.from) {
      where.push('p.scheduled_at >= ?');
      params.push(q.from);
    }
    if (q.to) {
      where.push('p.scheduled_at < ?');
      params.push(q.to);
    }
    if (q.q) {
      where.push("(v.title LIKE ? ESCAPE '\\' OR p.caption_snapshot LIKE ? ESCAPE '\\')");
      params.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`, `%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = q.page ?? 1;
    const size = q.page_size ?? 50;
    const total = await first<{ n: number }>(
      c.env.DB,
      `SELECT COUNT(*) AS n FROM posts p JOIN videos v ON v.id = p.video_id ${w}`,
      ...params,
    );
    const rows = await all<PostJoined>(
      c.env.DB,
      `${SELECT_JOINED} ${w} ORDER BY p.scheduled_at ASC LIMIT ? OFFSET ?`,
      ...params,
      size,
      (page - 1) * size,
    );
    return c.json<Paged<PostDTO>>({
      items: rows.map(toPostDTO),
      total: total?.n ?? 0,
      page,
      page_size: size,
    });
  })
  .get('/:id', async (c) => c.json<PostDTO>(await getJoined(c.env.DB, c.req.param('id'))))
  .get('/:id/events', async (c) => {
    const rows = await all<{
      id: string;
      at: string;
      from_status: PostStatus | null;
      to_status: PostStatus | null;
      step: string | null;
      detail: string | null;
    }>(
      c.env.DB,
      'SELECT id, at, from_status, to_status, step, detail FROM post_events WHERE post_id = ? ORDER BY at DESC, rowid DESC LIMIT 200',
      c.req.param('id'),
    );
    return c.json<PostEventDTO[]>(rows.map((r) => ({ ...r, detail: parseJson(r.detail, null) })));
  })
  .post('/manual', v('json', manualScheduleSchema), async (c) => {
    const b = c.req.valid('json');
    const now = new Date();
    const video = await first<VideoRow>(
      c.env.DB,
      'SELECT * FROM videos WHERE id = ? AND deleted_at IS NULL',
      b.video_id,
    );
    if (!video) throw notFound('Video');
    if (video.status === 'uploading' || video.status === 'archived')
      throw conflict('Video planlanabilir durumda değil');
    const brand = (await first<BrandRow>(
      c.env.DB,
      'SELECT * FROM brands WHERE id = ?',
      video.brand_id,
    )) as BrandRow;
    const at = zonedToUtc(b.date, b.time, brand.timezone);
    if (at.getTime() < now.getTime() - 60_000)
      throw badRequest('Geçmiş bir zaman seçilemez', 'past_time');
    const val = parseJson<ValidationResult | null>(video.validation, null);
    const planned: PlannedPost[] = [];
    for (const p of [...new Set(b.platforms)]) {
      const acc = await first<AccountRow>(
        c.env.DB,
        "SELECT * FROM accounts WHERE brand_id = ? AND platform = ? AND status = 'active'",
        video.brand_id,
        p,
      );
      if (!acc) throw badRequest(`${p} hesabı bağlı değil`, 'no_account');
      if (val && !val[p].ok)
        throw badRequest(
          val[p].issues.find((i) => i.severity === 'error')?.message ?? `${p} için uygun değil`,
          'video_invalid',
        );
      if (await hashUsedOnAccount(c.env.DB, video.content_hash, acc.id))
        throw conflict(
          `Bu video (aynı içerik) bu ${p} hesabına zaten planlanmış/paylaşılmış`,
          'duplicate',
        );
      planned.push({
        id: newId(),
        trace_id: newId(),
        video_id: video.id,
        account_id: acc.id,
        platform: p,
        slot_id: null,
        scheduled_at: at.toISOString(),
        caption: captionFor(video, p),
      });
    }
    const stmts: D1PreparedStatement[] = [];
    for (const p of planned) {
      stmts.push(insertPostStmt(c.env.DB, video.brand_id, p, b.status ?? 'scheduled', now));
      stmts.push(
        eventStmt(
          c.env.DB,
          p,
          null,
          b.status ?? 'scheduled',
          null,
          { source: 'manual', actor: c.get('actor') },
          now,
        ),
      );
    }
    stmts.push(syncVideoStatusStmt(c.env.DB, video.id, now));
    const res = await c.env.DB.batch(stmts);
    const created = planned.filter((_, i) => (res[i * 2]?.meta.changes ?? 0) === 1);
    if (created.length !== planned.length)
      throw conflict('Bu video seçilen hesaplardan birine zaten planlanmış', 'duplicate');
    await audit(c.env.DB, c.get('actor'), 'post.schedule_manual', 'video', video.id, {
      platforms: b.platforms,
      at: at.toISOString(),
    });
    return c.json<PostDTO[]>(await Promise.all(created.map((p) => getJoined(c.env.DB, p.id))), 201);
  })
  .post('/fill', v('json', fillSchema), async (c) => {
    const b = c.req.valid('json');
    const s = await getSettings(c.env.DB);
    const r = await fillQueue(c.env.DB, b.brand_id, b.days ?? s.autofill_default_days, new Date());
    await audit(c.env.DB, c.get('actor'), 'queue.fill', 'brand', b.brand_id, {
      created: r.created,
      days: b.days,
    });
    return c.json({ created: r.created, occurrences: r.occurrences, videos_used: r.videos_used });
  })
  .patch('/:id', v('json', postUpdateSchema), async (c) => {
    const id = c.req.param('id');
    const b = c.req.valid('json');
    const p = await getPost(c.env.DB, id);
    if (!['draft', 'scheduled', 'needs_action', 'failed'].includes(p.status))
      throw conflict('İşlenen veya yayınlanmış paylaşım düzenlenemez', 'not_editable');
    if (b.scheduled_at && new Date(b.scheduled_at).getTime() < Date.now() - 60_000)
      throw badRequest('Geçmiş bir zaman seçilemez', 'past_time');
    const r = await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE posts SET caption_snapshot = ?, scheduled_at = ?, slot_id = CASE WHEN ? IS NULL THEN slot_id ELSE NULL END, updated_at = ? WHERE id = ? AND status = ?',
      ).bind(
        b.caption_snapshot ?? p.caption_snapshot,
        b.scheduled_at ? new Date(b.scheduled_at).toISOString() : p.scheduled_at,
        b.scheduled_at ?? null,
        nowIso(),
        id,
        p.status,
      ),
      eventStmt(c.env.DB, p, p.status, p.status, p.step, {
        edit: Object.keys(b),
        actor: c.get('actor'),
        scheduled_at: b.scheduled_at ?? null,
      }),
    ]);
    if ((r[0]?.meta.changes ?? 0) !== 1) throw conflict('Paylaşım bu sırada değişti, yenileyin');
    return c.json<PostDTO>(await getJoined(c.env.DB, id));
  })
  .post('/:id/cancel', async (c) => {
    const p = await getPost(c.env.DB, c.req.param('id'));
    if (!canTransition(p.status, 'cancelled', 'human'))
      throw invalidTransition(p.status, 'cancelled');
    const ok = await humanTransition(c.env.DB, p, c.get('actor'), {
      to: 'cancelled',
      set: { lease_owner: null, lease_until: null },
    });
    if (!ok) throw conflict('Paylaşım bu sırada değişti, yenileyin');
    await syncVideoStatusStmt(c.env.DB, p.video_id).run();
    await audit(c.env.DB, c.get('actor'), 'post.cancel', 'post', p.id);
    return c.json<PostDTO>(await getJoined(c.env.DB, p.id));
  })
  .post('/:id/retry', async (c) => {
    const p = await getPost(c.env.DB, c.req.param('id'));
    if (
      !canTransition(p.status, 'scheduled', 'human') ||
      p.status === 'scheduled' ||
      p.status === 'draft'
    )
      throw invalidTransition(p.status, 'scheduled');
    const now = new Date();
    const ok = await humanTransition(c.env.DB, p, c.get('actor'), {
      to: 'scheduled',
      set: {
        scheduled_at: nowIso(now),
        attempt_count: 0,
        error_class: null,
        last_error_code: null,
        last_error_message: null,
        next_attempt_at: null,
        lease_owner: null,
        lease_until: null,
      },
      detail: { action: 'retry', prior_error: p.last_error_code },
    });
    if (!ok) throw conflict('Paylaşım bu sırada değişti, yenileyin');
    await audit(c.env.DB, c.get('actor'), 'post.retry', 'post', p.id, {
      prior_error: p.last_error_code,
    });
    await dispatchNow(c.env, p.id, now);
    return c.json<PostDTO>(await getJoined(c.env.DB, p.id));
  })
  .post('/:id/publish-now', async (c) => {
    const p = await getPost(c.env.DB, c.req.param('id'));
    if (p.status !== 'scheduled' && p.status !== 'draft')
      throw invalidTransition(p.status, 'processing');
    const now = new Date();
    const ok = await humanTransition(c.env.DB, p, c.get('actor'), {
      to: 'scheduled',
      set: { scheduled_at: nowIso(now) },
      detail: { action: 'publish_now' },
    });
    if (!ok) throw conflict('Paylaşım bu sırada değişti, yenileyin');
    await audit(c.env.DB, c.get('actor'), 'post.publish_now', 'post', p.id);
    await dispatchNow(c.env, p.id, now);
    return c.json<PostDTO>(await getJoined(c.env.DB, p.id));
  })
  .post('/:id/mark-published', v('json', markPublishedSchema), async (c) => {
    const p = await getPost(c.env.DB, c.req.param('id'));
    const { url } = c.req.valid('json');
    if (!canTransition(p.status, 'published', 'human'))
      throw invalidTransition(p.status, 'published');
    if (url && p.platform === 'tiktok' && !/^https:\/\/(www\.|vm\.|vt\.)?tiktok\.com\//.test(url))
      throw badRequest('TikTok bağlantısı bekleniyor (https://www.tiktok.com/...)');
    const postId = url?.match(/\/video\/(\d+)/)?.[1] ?? null;
    const ok = await humanTransition(c.env.DB, p, c.get('actor'), {
      to: 'published',
      set: {
        published_at: nowIso(),
        external_url: url ?? p.external_url,
        visibility: 'public',
        platform_state: JSON.stringify({
          ...parseJson(p.platform_state, {}),
          post_id: postId ?? undefined,
        }),
        lease_owner: null,
        lease_until: null,
      },
      detail: { action: 'mark_published', url: url ?? null },
    });
    if (!ok) throw conflict('Paylaşım bu sırada değişti, yenileyin');
    await syncVideoStatusStmt(c.env.DB, p.video_id).run();
    await audit(c.env.DB, c.get('actor'), 'post.mark_published', 'post', p.id, {
      url: url ?? null,
    });
    return c.json<PostDTO>(await getJoined(c.env.DB, p.id));
  })
  /** Audit sonrası: private yüklenmiş YouTube videosunu public yap. */
  .post('/:id/youtube-public', async (c) => {
    const p = await getPost(c.env.DB, c.req.param('id'));
    if (p.platform !== 'youtube' || p.status !== 'published' || !p.external_id)
      throw badRequest('Yalnız yayınlanmış YouTube videoları için');
    if (p.visibility === 'public') return c.json<PostDTO>(await getJoined(c.env.DB, p.id));
    const s = await getSettings(c.env.DB);
    if (!s.youtube_audited)
      throw conflict('YouTube audit onayı olmadan video public yapılamaz', 'not_audited');
    const acc = await first<AccountRow>(
      c.env.DB,
      'SELECT * FROM accounts WHERE id = ?',
      p.account_id,
    );
    const video = await first<VideoRow>(
      c.env.DB,
      'SELECT made_for_kids FROM videos WHERE id = ?',
      p.video_id,
    );
    if (!acc) throw notFound('Hesap');
    try {
      const t = await readTokens(c.env, acc);
      const vis = await makeYoutubePublic(
        createHttp(c.env, c.get('log')),
        t.access_token,
        p.external_id,
        video?.made_for_kids === 1,
        new Date(),
      );
      await c.env.DB.batch([
        c.env.DB.prepare('UPDATE posts SET visibility = ?, updated_at = ? WHERE id = ?').bind(
          vis,
          nowIso(),
          p.id,
        ),
        eventStmt(c.env.DB, p, 'published', 'published', 'make_public', {
          actor: c.get('actor'),
          visibility: vis,
        }),
      ]);
    } catch (e) {
      const msg =
        e instanceof PlatformHttpError ? e.message : e instanceof Error ? e.message : String(e);
      throw new HttpError(
        422,
        'youtube_update_failed',
        `${msg} (audit öncesi yüklenen videolar kalıcı private kalabilir)`,
      );
    }
    await audit(c.env.DB, c.get('actor'), 'post.youtube_public', 'post', p.id);
    return c.json<PostDTO>(await getJoined(c.env.DB, p.id));
  })
  .post('/bulk', v('json', bulkPostsSchema), async (c) => {
    const { ids, action } = c.req.valid('json');
    const now = new Date();
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of ids) {
      const p = await first<PostRow>(c.env.DB, 'SELECT * FROM posts WHERE id = ?', id);
      if (!p) {
        results.push({ id, ok: false, error: 'bulunamadı' });
        continue;
      }
      if (action === 'cancel') {
        if (!canTransition(p.status, 'cancelled', 'human')) {
          results.push({ id, ok: false, error: 'iptal edilemez' });
          continue;
        }
        const ok = await humanTransition(c.env.DB, p, c.get('actor'), {
          to: 'cancelled',
          set: { lease_owner: null, lease_until: null },
        });
        if (ok) await syncVideoStatusStmt(c.env.DB, p.video_id).run();
        results.push({ id, ok });
      } else {
        if (p.status !== 'failed' && p.status !== 'needs_action') {
          results.push({ id, ok: false, error: 'yalnız hata / işlem gerekli' });
          continue;
        }
        const ok = await humanTransition(c.env.DB, p, c.get('actor'), {
          to: 'scheduled',
          set: {
            scheduled_at: nowIso(now),
            attempt_count: 0,
            error_class: null,
            last_error_code: null,
            last_error_message: null,
            next_attempt_at: null,
          },
          detail: { action: 'retry', bulk: true },
        });
        if (ok) await dispatchNow(c.env, id, now);
        results.push({ id, ok });
      }
    }
    await audit(c.env.DB, c.get('actor'), `post.bulk_${action}`, 'post', null, {
      count: ids.length,
    });
    return c.json({ results });
  });
