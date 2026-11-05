import { Hono } from 'hono';
import { DEFAULT_MODE, platformSchema, type AccountDTO, type QuotaDTO } from '@socialplan/shared';
import { z } from 'zod';
import { isDryRun } from '../env';
import { encryptJson } from '../lib/crypto';
import { newId } from '../lib/db';
import { badRequest, conflict } from '../lib/errors';
import { v } from '../lib/validate';
import { pacificDay, QUOTAS } from '@socialplan/shared';
import { all, first, nowIso, parseJson, run } from '../lib/db';
import { toAccountDTO } from '../lib/dto';
import { notFound } from '../lib/errors';
import { audit } from '../lib/audit';
import { getQuota } from '../lib/quota';
import type { AccountRow } from '../lib/rows';
import type { AppEnv } from '../types';

export const accountRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const brandId = c.req.query('brand_id');
    const rows = brandId
      ? await all<AccountRow>(
          c.env.DB,
          "SELECT * FROM accounts WHERE brand_id = ? AND status <> 'disabled' ORDER BY platform",
          brandId,
        )
      : await all<AccountRow>(
          c.env.DB,
          "SELECT * FROM accounts WHERE status <> 'disabled' ORDER BY brand_id, platform",
        );
    return c.json<AccountDTO[]>(rows.map((r) => toAccountDTO(c.env, r)));
  })
  .get('/quota', async (c) => {
    const day = pacificDay(new Date());
    const igRows = await all<AccountRow>(
      c.env.DB,
      "SELECT * FROM accounts WHERE platform = 'instagram' AND status <> 'disabled'",
    );
    const instagram: QuotaDTO['instagram'] = {};
    for (const a of igRows) {
      const m = parseJson<{
        publishing_limit?: { quota_usage: number; quota_total: number | null; fetched_at: string };
      }>(a.meta, {});
      instagram[a.id] = {
        quota_usage: m.publishing_limit?.quota_usage ?? null,
        quota_total: m.publishing_limit?.quota_total ?? null,
        fetched_at: m.publishing_limit?.fetched_at ?? null,
      };
    }
    return c.json<QuotaDTO>({
      youtube: {
        day,
        uploads_used: await getQuota(c.env.DB, 'youtube', 'project', day, 'uploads'),
        uploads_limit: QUOTAS.youtube.uploadsPerDay.value,
        units_used: await getQuota(c.env.DB, 'youtube', 'project', day, 'units'),
        units_limit: QUOTAS.youtube.unitsPerDay.value,
      },
      instagram,
    });
  })
  /** Yalnız DRY_RUN: OAuth olmadan sahte hesap (paneli denemek için). */
  .post(
    '/demo',
    v('json', z.object({ brand_id: z.string().min(1), platform: platformSchema })),
    async (c) => {
      if (!isDryRun(c.env))
        throw badRequest('Demo hesap yalnız DRY_RUN açıkken eklenebilir', 'not_dry_run');
      const { brand_id, platform } = c.req.valid('json');
      const exists = await first(
        c.env.DB,
        "SELECT id FROM accounts WHERE brand_id = ? AND platform = ? AND status <> 'disabled'",
        brand_id,
        platform,
      );
      if (exists) throw conflict('Bu markada bu platform zaten bağlı');
      const id = newId();
      const at = nowIso();
      const { blob, version } = await encryptJson(c.env, { access_token: 'demo' });
      await c.env.DB.batch([
        c.env.DB.prepare(
          "DELETE FROM accounts WHERE brand_id = ? AND platform = ? AND status = 'disabled' AND NOT EXISTS (SELECT 1 FROM posts WHERE posts.account_id = accounts.id)",
        ).bind(brand_id, platform),
        c.env.DB.prepare(
          `INSERT INTO accounts (id, brand_id, platform, mode, external_id, username, display_name, secret_blob, secret_key_version, token_expires_at, scopes, status, meta, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo', 'active', '{"demo":true}', ?, ?)`,
        ).bind(
          id,
          brand_id,
          platform,
          DEFAULT_MODE[platform],
          `demo-${id.slice(0, 8)}`,
          `demo_${platform}`,
          `Demo ${platform}`,
          blob,
          version,
          new Date(Date.now() + 60 * 86400_000).toISOString(),
          at,
          at,
        ),
      ]);
      await audit(c.env.DB, c.get('actor'), 'account.demo', 'account', id, { platform });
      return c.json({ id }, 201);
    },
  )
  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    const cur = await first<AccountRow>(c.env.DB, 'SELECT * FROM accounts WHERE id = ?', id);
    if (!cur) throw notFound('Hesap');
    // Bağlantıyı kopar: token'ı sil, hesabı devre dışı bırak (UNIQUE için external_id'yi serbest bırak).
    await run(
      c.env.DB,
      "UPDATE accounts SET status = 'disabled', secret_blob = NULL, external_id = external_id || ':disabled:' || ?, updated_at = ? WHERE id = ?",
      nowIso(),
      nowIso(),
      id,
    );
    await audit(c.env.DB, c.get('actor'), 'account.disconnect', 'account', id, {
      platform: cur.platform,
      username: cur.username,
    });
    return c.json({ ok: true });
  });
