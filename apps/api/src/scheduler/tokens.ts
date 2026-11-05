import '../publish/publishers';
/** Token yenileme: IG bitişe 10 gün kala, TikTok/YouTube süre dolmadan (publisher.refreshLeadSeconds). */
import { PLATFORM_LABELS } from '@socialplan/shared';
import { isDryRun, type Env } from '../env';
import { all, nowIso } from '../lib/db';
import type { Logger } from '../lib/log';
import type { AccountRow } from '../lib/rows';
import { notify } from '../notify';
import { createHttp } from '../publish/http';
import { refreshAccount } from '../publish/orchestrator';
import { platformPublisher } from '../publish/registry';

export async function refreshDueTokens(env: Env, now: Date, log: Logger): Promise<number> {
  if (isDryRun(env)) return 0;
  const rows = await all<AccountRow>(
    env.DB,
    "SELECT * FROM accounts WHERE status = 'active' AND token_expires_at IS NOT NULL ORDER BY token_expires_at LIMIT 20",
  );
  let n = 0;
  const http = createHttp(env, log);
  for (const a of rows) {
    const pub = platformPublisher(a.platform);
    if (!pub) continue;
    const expires = new Date(a.token_expires_at as string).getTime();
    if (expires - now.getTime() > pub.refreshLeadSeconds * 1000) continue;
    // Kilit + başarısızlık sonrası 10 dk bekleme refreshAccount içinde (refresh_lock_until).
    // Not: last_refreshed_at burada YAZILMAZ — Instagram'ın "token ≥ 24 sa yaşında" denetimi bu alana bakar.
    const r = await refreshAccount(env, http, log, a, pub, now);
    if (r.ok) n++;
    else if (!r.busy && expires - now.getTime() < 3 * 86400_000) {
      await notify(
        env,
        {
          kind: 'token_expiring',
          dedupeKey: `token_expiring:${a.id}:${nowIso(now).slice(0, 10)}`,
          title: `${PLATFORM_LABELS[a.platform]} token'ı bitmek üzere`,
          text: `@${a.username ?? a.external_id}: yenileme başarısız (${r.message ?? ''}). Hesabı yeniden bağlayın.`,
        },
        log,
      );
    }
  }
  return n;
}
