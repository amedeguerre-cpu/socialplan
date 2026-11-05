/** Bildirimler: Slack webhook ve/veya Telegram bot. dedupe_key ile tekrar engellenir; mesajda sır yok. */
import type { Env } from '../env';
import { newId, nowIso } from '../lib/db';
import { createLogger, maskString, type Logger } from '../lib/log';
import { getSettings } from '../lib/settings';
import { createHttp, type HttpClient } from '../publish/http';

export type NotifyKind =
  | 'publish_failed'
  | 'needs_action'
  | 'token_lost'
  | 'token_expiring'
  | 'queue_low'
  | 'kill_switch'
  | 'tiktok_inbox'
  | 'tiktok_inbox_reminder'
  | 'weekly_report'
  | 'dlq'
  | 'test';

export interface Notice {
  kind: NotifyKind;
  dedupeKey: string;
  title: string;
  text: string;
  url?: string;
}

const EMOJI: Record<NotifyKind, string> = {
  publish_failed: '❌',
  needs_action: '⚠️',
  token_lost: '🔌',
  token_expiring: '⏳',
  queue_low: '📭',
  kill_switch: '🛑',
  tiktok_inbox: '📲',
  tiktok_inbox_reminder: '⏰',
  weekly_report: '📊',
  dlq: '🧯',
  test: '✅',
};

export async function sendChannels(
  env: Env,
  http: HttpClient,
  n: Notice,
  channels: { slack: boolean; telegram: boolean },
): Promise<{ slack?: boolean; telegram?: boolean }> {
  const text = maskString(`${EMOJI[n.kind]} *${n.title}*\n${n.text}${n.url ? `\n${n.url}` : ''}`);
  const out: { slack?: boolean; telegram?: boolean } = {};
  if (channels.slack && env.SLACK_WEBHOOK_URL) {
    try {
      const r = await http.fetch(
        env.SLACK_WEBHOOK_URL,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        },
        { purpose: 'notify.slack' },
      );
      out.slack = r.ok;
    } catch {
      out.slack = false;
    }
  }
  if (channels.telegram && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      const r = await http.fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: text.replace(/\*/g, ''),
            disable_web_page_preview: true,
          }),
        },
        { purpose: 'notify.telegram' },
      );
      out.telegram = r.ok;
    } catch {
      out.telegram = false;
    }
  }
  return out;
}

/** Bildirimi bir kez gönder (dedupe_key). Gönderim hatası yayın akışını bozmaz. */
export async function notify(
  env: Env,
  n: Notice,
  log: Logger = createLogger(),
  http?: HttpClient,
): Promise<boolean> {
  const ins = await env.DB.prepare(
    'INSERT OR IGNORE INTO notifications (id, kind, dedupe_key, sent_at, payload) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(
      newId(),
      n.kind,
      n.dedupeKey,
      nowIso(),
      JSON.stringify({ title: n.title, text: maskString(n.text) }),
    )
    .run();
  if (ins.meta.changes !== 1) return false;
  try {
    const s = await getSettings(env.DB);
    await sendChannels(env, http ?? createHttp(env, log), n, s.notify);
  } catch (e) {
    log.warn('notify.failed', { kind: n.kind, err: String(e) });
  }
  return true;
}
