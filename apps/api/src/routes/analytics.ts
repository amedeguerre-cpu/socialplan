import { Hono } from 'hono';
import { z } from 'zod';
import { DEFAULT_TZ, platformSchema, type AnalyticsDTO, type Platform } from '@socialplan/shared';
import { isDryRun } from '../env';
import { all, first, newId, nowIso, type SqlValue } from '../lib/db';
import { computeAnalytics, type AnalyticsPoint } from '../lib/analytics';
import { badRequest, notFound } from '../lib/errors';
import { audit } from '../lib/audit';
import { v } from '../lib/validate';
import type { AccountRow, BrandRow } from '../lib/rows';
import type { AppEnv } from '../types';

const querySchema = z.object({
  brand_id: z.string().optional(),
  platform: platformSchema.optional(),
  days: z.coerce.number().int().min(1).max(365).optional(),
});

export const analyticsRoutes = new Hono<AppEnv>()
  .get('/', v('query', querySchema), async (c) => {
    const q = c.req.valid('query');
    const since = new Date(Date.now() - (q.days ?? 30) * 86400_000).toISOString();
    const where = ["p.status = 'published'", 'p.published_at >= ?'];
    const params: SqlValue[] = [since];
    if (q.brand_id) {
      where.push('p.brand_id = ?');
      params.push(q.brand_id);
    }
    if (q.platform) {
      where.push('p.platform = ?');
      params.push(q.platform);
    }
    const rows = await all<AnalyticsPoint & { post_id: string }>(
      c.env.DB,
      `SELECT p.id AS post_id, p.platform, p.brand_id, p.published_at, p.external_url AS url, v.title, m.views, m.likes, m.comments, m.shares, m.saves
       FROM posts p JOIN videos v ON v.id = p.video_id
       JOIN metrics m ON m.id = (SELECT id FROM metrics WHERE post_id = p.id ORDER BY fetched_at DESC LIMIT 1)
       WHERE ${where.join(' AND ')} LIMIT 5000`,
      ...params,
    );
    const brand = q.brand_id
      ? await first<BrandRow>(c.env.DB, 'SELECT timezone FROM brands WHERE id = ?', q.brand_id)
      : null;
    return c.json<AnalyticsDTO>(computeAnalytics(rows, brand?.timezone ?? DEFAULT_TZ));
  })
  /** Yalnız DRY_RUN: analiz ekranını denemek için sahte geçmiş paylaşım + metrik üretir. */
  .post(
    '/demo',
    v(
      'json',
      z.object({ brand_id: z.string().min(1), posts: z.number().int().min(1).max(300).optional() }),
    ),
    async (c) => {
      if (!isDryRun(c.env))
        throw badRequest('Demo metrik yalnız DRY_RUN açıkken üretilebilir', 'not_dry_run');
      const { brand_id, posts = 120 } = c.req.valid('json');
      const brand = await first<BrandRow>(c.env.DB, 'SELECT * FROM brands WHERE id = ?', brand_id);
      if (!brand) throw notFound('Marka');
      const accounts = await all<AccountRow>(
        c.env.DB,
        "SELECT * FROM accounts WHERE brand_id = ? AND status = 'active'",
        brand_id,
      );
      if (!accounts.length) throw badRequest('Önce hesap (veya demo hesap) bağlayın');
      // Tekrarlanabilir sözde rastgele
      let seed = 42;
      const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
      const stmts: D1PreparedStatement[] = [];
      const now = Date.now();
      for (let i = 0; i < posts; i++) {
        const acc = accounts[i % accounts.length] as AccountRow;
        const hour = [9, 12, 13, 18, 19, 20, 21][Math.floor(rnd() * 7)] as number;
        const at = new Date(now - Math.floor(rnd() * 60) * 86400_000);
        at.setUTCHours(hour - 3, Math.floor(rnd() * 60), 0, 0);
        const weekday = at.getUTCDay();
        const boost = (hour >= 19 ? 1.8 : 1) * (weekday === 5 || weekday === 6 ? 1.4 : 1);
        const views = Math.floor((500 + rnd() * 5000) * boost);
        const rate = (0.02 + rnd() * 0.05) * boost;
        const eng = Math.floor(views * rate);
        const vid = newId();
        const pid = newId();
        const iso = at.toISOString();
        stmts.push(
          c.env.DB.prepare(
            "INSERT INTO videos (id, brand_id, r2_key, original_name, mime, size_bytes, title, status, created_at, updated_at, deleted_at) VALUES (?, ?, 'demo', 'demo.mp4', 'video/mp4', 0, ?, 'archived', ?, ?, ?)",
          ).bind(vid, brand_id, `Demo video ${i + 1}`, iso, iso, iso),
          c.env.DB.prepare(
            "INSERT INTO posts (id, trace_id, video_id, account_id, brand_id, platform, scheduled_at, status, visibility, external_id, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'published', 'demo', ?, ?, ?, ?)",
          ).bind(
            pid,
            newId(),
            vid,
            acc.id,
            brand_id,
            acc.platform as Platform,
            iso,
            `demo-${pid.slice(0, 8)}`,
            iso,
            iso,
            iso,
          ),
          c.env.DB.prepare(
            'INSERT INTO metrics (id, post_id, fetched_at, views, likes, comments, shares, saves, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).bind(
            newId(),
            pid,
            nowIso(),
            views,
            Math.floor(eng * 0.7),
            Math.floor(eng * 0.1),
            Math.floor(eng * 0.1),
            acc.platform === 'instagram' ? Math.floor(eng * 0.1) : 0,
            '{"demo":true}',
          ),
        );
      }
      for (let i = 0; i < stmts.length; i += 90) await c.env.DB.batch(stmts.slice(i, i + 90));
      await audit(c.env.DB, c.get('actor'), 'analytics.demo', 'brand', brand_id, { posts });
      return c.json({ created: posts });
    },
  );
