/**
 * Dakikalık cron: zamanı gelmiş post'ları kilitleyip Queue'ya atar; kaçırılan slotları işaretler;
 * reaper; token yenileme; TikTok hatırlatması; günlük işler (İstanbul 04:10).
 */
import { PLATFORM_LABELS, zonedParts } from '@socialplan/shared';
import type { Env, PublishMessage } from '../env';
import { all, newId, nowIso } from '../lib/db';
import { createLogger, type Logger } from '../lib/log';
import { claimLease, eventStmt } from '../lib/posts';
import type { PostRow } from '../lib/rows';
import { getSettings } from '../lib/settings';
import { notify } from '../notify';
import { runDaily } from './daily';
import { sendWeeklyReports, WEEKLY_AT } from './weekly';
import { setRawSetting } from '../lib/settings';
import { refreshDueTokens } from './tokens';

const DISPATCH_LIMIT = 100;

export async function dispatchDue(
  env: Env,
  now: Date,
  graceMin: number,
  log: Logger,
): Promise<{ dispatched: number; missed: number }> {
  const db = env.DB;
  const due = await all<PostRow>(
    db,
    `SELECT p.* FROM posts p JOIN brands b ON b.id = p.brand_id
     WHERE p.status = 'scheduled' AND p.scheduled_at <= ? AND b.paused = 0 ORDER BY p.scheduled_at LIMIT ?`,
    nowIso(now),
    DISPATCH_LIMIT,
  );
  let dispatched = 0;
  let missed = 0;
  const msgs: MessageSendRequest<PublishMessage>[] = [];
  for (const p of due) {
    const lateMin = (now.getTime() - new Date(p.scheduled_at).getTime()) / 60_000;
    if (lateMin > graceMin) {
      // Kaçırılan slot: otomatik yayınlama yok, insan karar verir.
      const [r] = await db.batch([
        db
          .prepare(
            "UPDATE posts SET status = 'needs_action', error_class = 'action', last_error_code = 'missed_slot', last_error_message = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'",
          )
          .bind(
            `Slot ${Math.round(lateMin)} dk kaçırıldı (tolerans ${graceMin} dk)`,
            nowIso(now),
            p.id,
          ),
        eventStmt(
          db,
          p,
          'scheduled',
          'needs_action',
          null,
          { reason: 'missed_slot', late_min: Math.round(lateMin) },
          now,
        ),
      ]);
      if (r?.meta.changes === 1) {
        missed++;
        await notify(
          env,
          {
            kind: 'needs_action',
            dedupeKey: `missed:${p.id}`,
            title: `${PLATFORM_LABELS[p.platform]}: kaçırılan slot`,
            text: `Planlanan paylaşım ${Math.round(lateMin)} dk gecikti ve otomatik yayınlanmadı.`,
            url: `${env.APP_BASE_URL}/planlama?post=${p.id}`,
          },
          log,
        );
      }
      continue;
    }
    const owner = `cron:${newId()}`;
    const seq = await claimLease(db, p.id, owner, now);
    if (seq !== null) {
      await eventStmt(db, p, 'scheduled', 'processing', null, { by: 'cron' }, now).run();
      msgs.push({ body: { postId: p.id, traceId: p.trace_id, leaseOwner: owner, seq } });
      dispatched++;
    }
  }
  for (let i = 0; i < msgs.length; i += 100)
    await env.PUBLISH_QUEUE.sendBatch(msgs.slice(i, i + 100));
  return { dispatched, missed };
}

/** Lease'i dolmuş 'processing' post'ları yeni sahiple kuyruğa al. */
export async function reap(env: Env, now: Date, log: Logger): Promise<number> {
  const stale = await all<PostRow>(
    env.DB,
    "SELECT * FROM posts WHERE status = 'processing' AND lease_until < ? LIMIT 50",
    nowIso(now),
  );
  let n = 0;
  for (const p of stale) {
    const owner = `reaper:${newId()}`;
    const seq = await claimLease(env.DB, p.id, owner, now);
    if (seq !== null) {
      await eventStmt(
        env.DB,
        p,
        'processing',
        'processing',
        p.step,
        { reaped_from: p.lease_owner },
        now,
      ).run();
      await env.PUBLISH_QUEUE.send({ postId: p.id, traceId: p.trace_id, leaseOwner: owner, seq });
      n++;
    }
  }
  if (n) log.warn('reaper.requeued', { count: n });
  return n;
}

/** Taslağa gönderilmiş TikTok post'u 1 saat içinde yayınlanmadıysa bir kez daha hatırlat. */
export async function tiktokReminders(env: Env, now: Date, log: Logger): Promise<number> {
  const rows = await all<PostRow>(
    env.DB,
    "SELECT * FROM posts WHERE status = 'inbox_sent' AND updated_at < ? AND updated_at > ? LIMIT 50",
    new Date(now.getTime() - 3600_000).toISOString(),
    new Date(now.getTime() - 7 * 86400_000).toISOString(),
  );
  let n = 0;
  for (const p of rows) {
    const sent = await notify(
      env,
      {
        kind: 'tiktok_inbox_reminder',
        dedupeKey: `tiktok_inbox_reminder:${p.id}`,
        title: "Hatırlatma: TikTok'ta yayınla",
        text: 'TikTok taslağı 1 saattir bekliyor. Uygulamadan yayınlayın ve panelde "Yayınladım" işaretleyin.',
        url: `${env.APP_BASE_URL}/planlama?post=${p.id}`,
      },
      log,
    );
    if (sent) n++;
  }
  return n;
}

/** Günlük işlerin çalışacağı İstanbul saati (UTC 01:10). */
export const DAILY_AT = { tz: 'Europe/Istanbul', hour: 4, minute: 10 };

export async function handleScheduled(env: Env, now: Date, _cron: string): Promise<void> {
  const log = createLogger({ job: 'cron' });
  const settings = await getSettings(env.DB);
  if (settings.kill_switch) {
    log.warn('cron.kill_switch_on');
  } else {
    const d = await dispatchDue(env, now, settings.missed_slot_grace_min, log);
    if (d.dispatched || d.missed) log.info('cron.dispatch', d);
    await reap(env, now, log);
  }
  await tiktokReminders(env, now, log);
  await refreshDueTokens(env, now, log);
  const p = zonedParts(now, DAILY_AT.tz);
  if (p.hour === DAILY_AT.hour && p.minute === DAILY_AT.minute) {
    await runDaily(env, now, log);
    await setRawSetting(env.DB, 'last_daily_at', now.toISOString(), 'cron');
  }
  const w = zonedParts(now, WEEKLY_AT.tz);
  if (
    settings.weekly_report &&
    w.weekday === WEEKLY_AT.weekday &&
    w.hour === WEEKLY_AT.hour &&
    w.minute === WEEKLY_AT.minute
  ) {
    await sendWeeklyReports(env, now, log);
  }
  // Sağlık ekranı için son çalışma zamanı.
  await setRawSetting(env.DB, 'last_cron_at', now.toISOString(), 'cron');
}
