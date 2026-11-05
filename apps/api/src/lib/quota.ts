import type { Platform } from '@socialplan/shared';

/** Kota defteri: atomik "kullan, sınırı aşma". true = ayrıldı. */
export async function useQuota(
  db: D1Database,
  platform: Platform,
  scopeKey: string,
  day: string,
  bucket: string,
  amount: number,
  limit: number,
): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO quota_usage (platform, scope_key, day, bucket, used) SELECT ?1, ?2, ?3, ?4, ?5 WHERE ?5 <= ?6
       ON CONFLICT (platform, scope_key, day, bucket) DO UPDATE SET used = used + excluded.used WHERE quota_usage.used + excluded.used <= ?6`,
    )
    .bind(platform, scopeKey, day, bucket, amount, limit)
    .run();
  return r.meta.changes === 1;
}

export async function getQuota(
  db: D1Database,
  platform: Platform,
  scopeKey: string,
  day: string,
  bucket: string,
): Promise<number> {
  const r = await db
    .prepare(
      'SELECT used FROM quota_usage WHERE platform = ? AND scope_key = ? AND day = ? AND bucket = ?',
    )
    .bind(platform, scopeKey, day, bucket)
    .first<{ used: number }>();
  return r?.used ?? 0;
}
