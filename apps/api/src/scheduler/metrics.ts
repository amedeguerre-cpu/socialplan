/** Günlük metrik çekme: IG insights, YT statistics, TikTok video/query. Her çekim yeni satır (geçmiş korunur). */
import '../publish/publishers';
import { isDryRun, type Env } from '../env';
import { all, newId, nowIso, parseJson } from '../lib/db';
import type { Logger } from '../lib/log';
import { getQuota, useQuota } from '../lib/quota';
import type { AccountRow, PostRow } from '../lib/rows';
import { readTokens, type AccountTokens } from '../lib/tokens';
import { createHttp } from '../publish/http';
import { platformPublisher } from '../publish/registry';

/** Yayından sonra metrik izlenen süre. */
const TRACK_DAYS = 60;

/** Platformun metrik sorgusunda kullandığı kimlik (TikTok: publish_id değil post_id). */
export function metricId(
  p: Pick<PostRow, 'platform' | 'external_id' | 'platform_state'>,
): string | null {
  if (p.platform === 'tiktok')
    return parseJson<{ post_id?: string }>(p.platform_state, {}).post_id ?? null;
  return p.external_id;
}

export async function fetchAllMetrics(env: Env, now: Date, log: Logger): Promise<number> {
  if (isDryRun(env)) return 0;
  const since = new Date(now.getTime() - TRACK_DAYS * 86400_000).toISOString();
  const posts = await all<PostRow>(
    env.DB,
    "SELECT * FROM posts WHERE status = 'published' AND published_at >= ? AND external_id IS NOT NULL AND COALESCE(visibility, '') NOT IN ('dry-run', 'demo')",
    since,
  );
  const byAccount = new Map<string, PostRow[]>();
  for (const p of posts) byAccount.set(p.account_id, [...(byAccount.get(p.account_id) ?? []), p]);
  const http = createHttp(env, log);
  let n = 0;
  for (const [accountId, list] of byAccount) {
    const account = (
      await all<AccountRow>(
        env.DB,
        "SELECT * FROM accounts WHERE id = ? AND status = 'active'",
        accountId,
      )
    )[0];
    const pub = account ? platformPublisher(account.platform) : null;
    if (!account || !pub) continue;
    const ids = new Map<string, PostRow>();
    for (const p of list) {
      const id = metricId(p);
      if (id) ids.set(id, p);
    }
    if (!ids.size) continue;
    let cache: AccountTokens | null = null;
    try {
      const res = await pub.fetchMetrics(
        {
          env,
          http,
          log,
          now,
          account,
          tokens: async () => (cache ??= await readTokens(env, account)),
          quota: {
            use: (pl, k, d, b, a, l) => useQuota(env.DB, pl, k, d, b, a, l),
            get: (pl, k, d, b) => getQuota(env.DB, pl, k, d, b),
          },
        },
        [...ids.keys()],
      );
      const stmts = [...res.entries()].flatMap(([id, m]) => {
        const p = ids.get(id);
        return p
          ? [
              env.DB.prepare(
                'INSERT INTO metrics (id, post_id, fetched_at, views, likes, comments, shares, saves, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              ).bind(
                newId(),
                p.id,
                nowIso(now),
                m.views,
                m.likes,
                m.comments,
                m.shares,
                m.saves,
                JSON.stringify(m.raw).slice(0, 4000),
              ),
            ]
          : [];
      });
      if (stmts.length) await env.DB.batch(stmts);
      n += stmts.length;
    } catch (e) {
      log.warn('metrics.account_failed', {
        account_id: accountId,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return n;
}
