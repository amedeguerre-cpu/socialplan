/** Sağlık ekranı: cron, kuyruk, hatalar, ölü mektuplar, token'lar — tek bakışta. */
import { Hono } from 'hono';
import type { HealthCheck, HealthDTO, HealthLevel, Platform } from '@socialplan/shared';
import { isDryRun, type Env } from '../env';
import { all, first, parseJson } from '../lib/db';
import { getSettings } from '../lib/settings';
import type { AppEnv } from '../types';

const RANK: Record<HealthLevel, number> = { ok: 0, warn: 1, error: 2 };
const ago = (iso: string | null, now: Date): number | null =>
  iso ? (now.getTime() - new Date(iso).getTime()) / 60_000 : null;
const fmtMin = (m: number): string =>
  m < 90
    ? `${Math.round(m)} dk`
    : m < 48 * 60
      ? `${Math.round(m / 60)} sa`
      : `${Math.round(m / 1440)} gün`;

async function setting(db: D1Database, key: string): Promise<string | null> {
  const r = await first<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', key);
  return r ? parseJson<string | null>(r.value, null) : null;
}

export async function computeHealth(env: Env, now: Date): Promise<HealthDTO> {
  const db = env.DB;
  const n = now.toISOString();
  const day = new Date(now.getTime() - 86400_000).toISOString();
  const count = async (sql: string, ...p: string[]): Promise<number> =>
    (await first<{ n: number }>(db, sql, ...p))?.n ?? 0;
  const [
    s,
    lastCron,
    lastDaily,
    processing,
    retrying,
    stuck,
    overdue,
    needsAction,
    failed24,
    dlq24,
    inboxWaiting,
    tokens,
  ] = await Promise.all([
    getSettings(db),
    setting(db, 'last_cron_at'),
    setting(db, 'last_daily_at'),
    count("SELECT COUNT(*) AS n FROM posts WHERE status = 'processing'"),
    count("SELECT COUNT(*) AS n FROM posts WHERE status = 'processing' AND attempt_count > 0"),
    count("SELECT COUNT(*) AS n FROM posts WHERE status = 'processing' AND lease_until < ?", n),
    count(
      "SELECT COUNT(*) AS n FROM posts p JOIN brands b ON b.id = p.brand_id WHERE p.status = 'scheduled' AND b.paused = 0 AND p.scheduled_at < ?",
      new Date(now.getTime() - 3 * 60_000).toISOString(),
    ),
    count("SELECT COUNT(*) AS n FROM posts WHERE status = 'needs_action'"),
    count("SELECT COUNT(*) AS n FROM posts WHERE status = 'failed' AND updated_at >= ?", day),
    count("SELECT COUNT(*) AS n FROM post_events WHERE step = 'dlq' AND at >= ?", day),
    count(
      "SELECT COUNT(*) AS n FROM posts WHERE status = 'inbox_sent' AND updated_at < ?",
      new Date(now.getTime() - 3600_000).toISOString(),
    ),
    all<{
      id: string;
      platform: Platform;
      username: string | null;
      status: string;
      token_expires_at: string | null;
    }>(
      db,
      "SELECT id, platform, username, status, token_expires_at FROM accounts WHERE status <> 'disabled' ORDER BY token_expires_at",
    ),
  ]);
  const checks: HealthCheck[] = [];
  const add = (key: string, label: string, level: HealthLevel, detail: string) =>
    checks.push({ key, label, level, detail });

  const cronAgo = ago(lastCron, now);
  if (cronAgo === null)
    add('cron', 'Cron', 'warn', 'Henüz hiç çalışmadı (yeni kurulum veya yerel geliştirme)');
  else if (cronAgo > 5)
    add('cron', 'Cron', 'error', `Son çalışma ${fmtMin(cronAgo)} önce — her dakika çalışmalı`);
  else add('cron', 'Cron', 'ok', `Son çalışma ${fmtMin(cronAgo)} önce`);

  const dailyAgo = ago(lastDaily, now);
  if (dailyAgo === null) add('daily', 'Günlük işler', 'warn', 'Henüz çalışmadı (İstanbul 04:10)');
  else if (dailyAgo > 26 * 60)
    add('daily', 'Günlük işler', 'warn', `Son çalışma ${fmtMin(dailyAgo)} önce`);
  else add('daily', 'Günlük işler', 'ok', `Son çalışma ${fmtMin(dailyAgo)} önce`);

  if (s.kill_switch) add('kill_switch', 'Kill switch', 'warn', 'Açık — yeni paylaşım başlamaz');
  if (isDryRun(env)) add('dry_run', 'DRY_RUN', 'warn', 'Açık — platformlara istek gitmez');

  add(
    'overdue',
    'Geciken paylaşım',
    overdue ? 'error' : 'ok',
    overdue ? `${overdue} paylaşımın saati geçti ama başlamadı (cron/kuyruk?)` : 'Yok',
  );
  add(
    'stuck',
    'Takılan işlem',
    stuck ? 'warn' : 'ok',
    stuck ? `${stuck} işlemin kilidi doldu; reaper yeniden kuyruğa alacak` : 'Yok',
  );
  add(
    'needs_action',
    'İşlem gerekli',
    needsAction ? 'warn' : 'ok',
    needsAction ? `${needsAction} paylaşım insan kararı bekliyor` : 'Yok',
  );
  add(
    'failed',
    'Son 24 sa hata',
    failed24 ? 'warn' : 'ok',
    failed24 ? `${failed24} paylaşım hata ile bitti` : 'Yok',
  );
  add(
    'dlq',
    'Ölü mektup kuyruğu',
    dlq24 ? 'error' : 'ok',
    dlq24 ? `Son 24 sa ${dlq24} mesaj DLQ'ya düştü (beklenmeyen hata — logları inceleyin)` : 'Yok',
  );
  add(
    'inbox',
    'TikTok taslakları',
    inboxWaiting ? 'warn' : 'ok',
    inboxWaiting ? `${inboxWaiting} taslak 1 saatten uzun süredir yayın bekliyor` : 'Bekleyen yok',
  );

  const reconnect = tokens.filter((t) => t.status === 'reconnect');
  const expiring = tokens.filter(
    (t) =>
      t.status === 'active' &&
      t.token_expires_at &&
      new Date(t.token_expires_at).getTime() - now.getTime() < 3 * 86400_000 &&
      t.platform === 'instagram',
  );
  if (reconnect.length)
    add(
      'tokens',
      'Hesap bağlantıları',
      'error',
      `${reconnect.length} hesap yeniden bağlanmalı: ${reconnect.map((t) => `@${t.username ?? '?'}`).join(', ')}`,
    );
  else if (expiring.length)
    add(
      'tokens',
      'Hesap bağlantıları',
      'warn',
      `${expiring.length} Instagram token'ı 3 günden kısa sürede bitiyor`,
    );
  else add('tokens', 'Hesap bağlantıları', 'ok', `${tokens.length} hesap aktif`);

  const level = checks.reduce<HealthLevel>((a, c) => (RANK[c.level] > RANK[a] ? c.level : a), 'ok');
  return {
    level,
    now: n,
    checks,
    counts: {
      processing,
      retrying,
      overdue,
      needs_action: needsAction,
      failed_24h: failed24,
      dlq_24h: dlq24,
      inbox_waiting: inboxWaiting,
    },
    last_cron_at: lastCron,
    last_daily_at: lastDaily,
    tokens: tokens.map((t) => ({
      account_id: t.id,
      platform: t.platform,
      username: t.username,
      status: t.status,
      token_expires_at: t.token_expires_at,
    })),
  };
}

export const healthRoutes = new Hono<AppEnv>().get('/', async (c) =>
  c.json<HealthDTO>(await computeHealth(c.env, new Date())),
);
