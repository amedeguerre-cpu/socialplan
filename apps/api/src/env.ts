import type { Platform } from '@socialplan/shared';

export interface PublishMessage {
  postId: string;
  traceId: string;
  leaseOwner: string;
  /** Beklenen adım sırası (posts.msg_seq); eşleşmeyen kopya düşer. */
  seq: number;
}

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  PUBLISH_QUEUE: Queue<PublishMessage>;
  ASSETS: Fetcher;

  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  APP_BASE_URL: string;
  DRY_RUN: string;
  ALLOWED_ACCOUNT_IDS: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET: string;
  GOOGLE_CLIENT_ID: string;
  IG_APP_ID: string;
  TIKTOK_CLIENT_KEY: string;
  TELEGRAM_CHAT_ID: string;
  /** Yalnız .dev.vars — production'da tanımlıysa Worker açılmaz. */
  ACCESS_DEV_BYPASS?: string;

  TOKEN_ENC_KEY: string;
  TOKEN_ENC_KEY_PREV?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  GOOGLE_CLIENT_SECRET?: string;
  IG_APP_SECRET?: string;
  TIKTOK_CLIENT_SECRET?: string;
  SLACK_WEBHOOK_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
}

export const isDryRun = (env: Env): boolean => env.DRY_RUN !== 'false';

export function allowedAccountIds(env: Env): string[] {
  return (env.ALLOWED_ACCOUNT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Beyaz liste boşsa herkes; doluysa yalnız listedekiler (iç id veya platform external_id). */
export function isAccountAllowed(env: Env, account: { id: string; external_id: string }): boolean {
  const list = allowedAccountIds(env);
  return list.length === 0 || list.includes(account.id) || list.includes(account.external_id);
}

export function isLocalBaseUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  } catch {
    return false;
  }
}

export class ConfigError extends Error {}

/** Açılış denetimi: güvenlik açısından tehlikeli yapılandırmada Worker çalışmaz. */
export function assertSafeConfig(env: Env): void {
  if (env.ACCESS_DEV_BYPASS && !isLocalBaseUrl(env.APP_BASE_URL)) {
    throw new ConfigError('ACCESS_DEV_BYPASS production ortamında tanımlı: Worker açılmıyor.');
  }
  if (!env.TOKEN_ENC_KEY) throw new ConfigError('TOKEN_ENC_KEY tanımlı değil.');
}

export const PLATFORM_CLIENT_ID: Record<Platform, keyof Env> = {
  instagram: 'IG_APP_ID',
  youtube: 'GOOGLE_CLIENT_ID',
  tiktok: 'TIKTOK_CLIENT_KEY',
};
