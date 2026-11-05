/**
 * TikTok webhook ucu (Access DIŞINDA: Cloudflare Access'te /webhooks/* için Bypass kuralı gerekir).
 * İmza: TikTok-Signature: t=<unix>,s=<hex HMAC-SHA256(client_secret, `${t}.${gövde}`)>.
 * TODO(doğrula): imza biçimi ve olay adları gerçek bir webhook ile doğrulanmalı.
 * Teslimat en-az-bir-kez: tüm güncellemeler koşullu ve idempotent.
 */
import { Hono } from 'hono';
import { assertTransition } from '@socialplan/shared';
import { hmacSha256Hex, timingSafeEqual } from '../lib/crypto';
import { first, nowIso, parseJson } from '../lib/db';
import { createLogger } from '../lib/log';
import { eventStmt, syncVideoStatusStmt } from '../lib/posts';
import type { AccountRow, PostRow } from '../lib/rows';
import type { Env } from '../env';

const MAX_SKEW_SEC = 5 * 60;

export async function verifyTiktokSignature(
  env: Env,
  header: string | undefined,
  body: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !env.TIKTOK_CLIENT_SECRET) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.trim().split('=') as [string, string]),
  );
  const t = Number(parts.t);
  const s = parts.s ?? '';
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > MAX_SKEW_SEC) return false;
  const expected = await hmacSha256Hex(env.TIKTOK_CLIENT_SECRET, `${t}.${body}`);
  return timingSafeEqual(expected, s.toLowerCase());
}

interface TtWebhook {
  client_key?: string;
  event?: string;
  create_time?: number;
  user_openid?: string;
  content?: string;
}

export const webhookRoutes = new Hono<{ Bindings: Env }>().post('/tiktok', async (c) => {
  const log = createLogger({ webhook: 'tiktok' });
  const raw = await c.req.text();
  if (!(await verifyTiktokSignature(c.env, c.req.header('tiktok-signature'), raw))) {
    log.warn('webhook.bad_signature');
    return c.json({ error: 'bad_signature' }, 401);
  }
  const evt = parseJson<TtWebhook>(raw, {});
  if (evt.client_key && c.env.TIKTOK_CLIENT_KEY && evt.client_key !== c.env.TIKTOK_CLIENT_KEY)
    return c.json({ ok: true, ignored: 'client_key' });
  const content = parseJson<{ publish_id?: string; post_id?: string | number; reason?: string }>(
    evt.content,
    {},
  );
  if (!content.publish_id) return c.json({ ok: true, ignored: 'no_publish_id' });
  const db = c.env.DB;
  const post = await first<PostRow>(
    db,
    "SELECT * FROM posts WHERE platform = 'tiktok' AND external_id = ?",
    content.publish_id,
  );
  if (!post) return c.json({ ok: true, ignored: 'unknown_publish_id' });
  const now = new Date();
  switch (evt.event) {
    case 'post.publish.publicly_available': {
      if (post.status === 'published') return c.json({ ok: true, idempotent: true });
      if (
        post.status !== 'inbox_sent' &&
        post.status !== 'needs_action' &&
        post.status !== 'processing'
      )
        return c.json({ ok: true, ignored: post.status });
      const from = post.status;
      if (from !== 'needs_action') assertTransition(from, 'published', 'system');
      const acc = await first<AccountRow>(
        db,
        'SELECT username FROM accounts WHERE id = ?',
        post.account_id,
      );
      const postId = content.post_id ? String(content.post_id) : null;
      const url = postId
        ? `https://www.tiktok.com/@${acc?.username ?? ''}/video/${postId}`
        : post.external_url;
      const state = {
        ...parseJson<Record<string, unknown>>(post.platform_state, {}),
        post_id: postId ?? undefined,
      };
      await db.batch([
        db
          .prepare(
            "UPDATE posts SET status = 'published', published_at = COALESCE(published_at, ?), external_url = ?, visibility = 'public', platform_state = ?, lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = ?",
          )
          .bind(nowIso(now), url, JSON.stringify(state), nowIso(now), post.id, from),
        eventStmt(
          db,
          post,
          from,
          'published',
          post.step,
          { source: 'webhook', event: evt.event, post_id: postId },
          now,
        ),
        syncVideoStatusStmt(db, post.video_id, now),
      ]);
      break;
    }
    case 'post.publish.failed': {
      if (post.status !== 'inbox_sent') return c.json({ ok: true, ignored: post.status });
      assertTransition('inbox_sent', 'needs_action', 'system');
      await db.batch([
        db
          .prepare(
            "UPDATE posts SET status = 'needs_action', error_class = 'action', last_error_code = 'tt_publish_failed', last_error_message = ?, updated_at = ? WHERE id = ? AND status = 'inbox_sent'",
          )
          .bind(`TikTok yayını başarısız: ${content.reason ?? 'bilinmiyor'}`, nowIso(now), post.id),
        eventStmt(
          db,
          post,
          'inbox_sent',
          'needs_action',
          post.step,
          { source: 'webhook', event: evt.event, reason: content.reason ?? null },
          now,
        ),
      ]);
      break;
    }
    default:
      await eventStmt(
        db,
        post,
        post.status,
        post.status,
        post.step,
        { source: 'webhook', event: evt.event ?? 'unknown' },
        now,
      ).run();
  }
  log.info('webhook.handled', { event: evt.event, post_id: post.id });
  return c.json({ ok: true });
});
