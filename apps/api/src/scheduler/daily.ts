/** Günlük işler: otomatik doldurma, kuyruk uyarısı, metrik çekme, retention temizliği. */
import type { Env } from '../env';
import { all, nowIso } from '../lib/db';
import type { Logger } from '../lib/log';
import type { BrandRow } from '../lib/rows';
import { getSettings } from '../lib/settings';
import { notify } from '../notify';
import { brandStats } from '../routes/brands';
import { fillQueue } from './fill';
import { fetchAllMetrics } from './metrics';

export async function autofill(env: Env, now: Date, log: Logger): Promise<number> {
  const brands = await all<BrandRow>(
    env.DB,
    'SELECT * FROM brands WHERE autofill_enabled = 1 AND paused = 0',
  );
  let n = 0;
  for (const b of brands) {
    try {
      n += (await fillQueue(env.DB, b.id, b.autofill_days, now)).created;
    } catch (e) {
      log.error('autofill.failed', { brand_id: b.id, err: String(e) });
    }
  }
  return n;
}

export async function queueWarnings(env: Env, now: Date, log: Logger): Promise<number> {
  const brands = await all<BrandRow>(env.DB, 'SELECT * FROM brands WHERE paused = 0');
  const stats = await brandStats(env.DB);
  let n = 0;
  for (const b of brands) {
    const s = stats.get(b.id);
    if (!s || s.queue_days_left === null || s.queue_days_left >= 3) continue;
    const sent = await notify(
      env,
      {
        kind: 'queue_low',
        dedupeKey: `queue_low:${b.id}:${nowIso(now).slice(0, 10)}`,
        title: `${b.name}: kuyruk azalıyor`,
        text: `Kuyrukta ${s.queue_count} video var (≈ ${s.queue_days_left} gün). Yeni video yükleyin.`,
        url: `${env.APP_BASE_URL}/videolar`,
      },
      log,
    );
    if (sent) n++;
  }
  return n;
}

/** Bütün platformlarda yayınlandıktan retention_days sonra R2 videosunu sil (thumbnail kalır). */
export async function retention(env: Env, now: Date, log: Logger): Promise<number> {
  const s = await getSettings(env.DB);
  const cutoff = new Date(now.getTime() - s.retention_days * 86400_000).toISOString();
  const rows = await all<{ id: string; r2_key: string }>(
    env.DB,
    `SELECT v.id, v.r2_key FROM videos v WHERE v.status = 'published' AND v.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.video_id = v.id AND p.status NOT IN ('published','cancelled'))
     AND (SELECT MAX(p.published_at) FROM posts p WHERE p.video_id = v.id AND p.status = 'published') < ? LIMIT 100`,
    cutoff,
  );
  for (const r of rows) {
    await env.MEDIA.delete(r.r2_key);
    await env.DB.prepare(
      "UPDATE videos SET deleted_at = ?, status = 'archived', updated_at = ? WHERE id = ?",
    )
      .bind(nowIso(now), nowIso(now), r.id)
      .run();
  }
  if (rows.length) log.info('retention.deleted', { count: rows.length });
  return rows.length;
}

export async function runDaily(env: Env, now: Date, log: Logger): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  out.autofill = await autofill(env, now, log);
  out.queue_warnings = await queueWarnings(env, now, log);
  out.metrics = await fetchAllMetrics(env, now, log).catch((e) => {
    log.error('metrics.failed', { err: String(e) });
    return 0;
  });
  out.retention = await retention(env, now, log);
  await env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(nowIso(now)).run();
  log.info('daily.done', out);
  return out;
}
