import type { Env } from '../env';
import { all, nowIso } from '../lib/db';
import type { Logger } from '../lib/log';
import type { BrandRow } from '../lib/rows';
import { buildWeeklyReport } from '../lib/weekly';
import { notify } from '../notify';

/** Haftalık özetin gönderileceği an: Pazartesi 09:05 (İstanbul). */
export const WEEKLY_AT = { tz: 'Europe/Istanbul', weekday: 1, hour: 9, minute: 5 };

export async function sendWeeklyReports(
  env: Env,
  now: Date,
  log: Logger,
  opts: { brandId?: string; force?: boolean } = {},
): Promise<number> {
  const brands = opts.brandId
    ? await all<BrandRow>(env.DB, 'SELECT * FROM brands WHERE id = ?', opts.brandId)
    : await all<BrandRow>(env.DB, 'SELECT * FROM brands WHERE paused = 0 ORDER BY name');
  let n = 0;
  for (const b of brands) {
    try {
      const r = await buildWeeklyReport(env.DB, b, now, env.APP_BASE_URL);
      const key = opts.force
        ? `weekly:${b.id}:${nowIso(now)}`
        : `weekly:${b.id}:${nowIso(now).slice(0, 10)}`;
      if (
        await notify(
          env,
          {
            kind: 'weekly_report',
            dedupeKey: key,
            title: `${b.name} — haftalık özet`,
            text: r.text,
          },
          log,
        )
      )
        n++;
    } catch (e) {
      log.error('weekly.failed', {
        brand_id: b.id,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return n;
}
