import { DEFAULT_MODE, type Platform } from '@socialplan/shared';
import type { Env } from '../env';
import { encryptJson } from './crypto';
import { first, newId, nowIso } from './db';
import { conflict } from './errors';
import type { AccountRow } from './rows';
import type { OAuthProfile, OAuthTokenResult } from '../oauth/types';

/**
 * Hesap bağla/yeniden bağla. Marka × platform başına tek satır (UNIQUE): varsa yerinde güncellenir
 * (geçmiş post'lar aynı satıra bağlı kalır). Aynı platform hesabı başka markaya bağlıysa reddedilir.
 */
export async function upsertAccount(
  env: Env,
  brandId: string,
  platform: Platform,
  profile: OAuthProfile,
  tok: OAuthTokenResult,
  now = new Date(),
): Promise<string> {
  const db = env.DB;
  const other = await first<AccountRow>(
    db,
    "SELECT * FROM accounts WHERE platform = ? AND external_id = ? AND brand_id <> ? AND status <> 'disabled'",
    platform,
    profile.external_id,
    brandId,
  );
  if (other) throw conflict('Bu platform hesabı başka bir markaya bağlı', 'account_in_use');
  const { blob, version } = await encryptJson(env, tok.tokens);
  const cur = await first<AccountRow>(
    db,
    'SELECT * FROM accounts WHERE brand_id = ? AND platform = ?',
    brandId,
    platform,
  );
  const at = nowIso(now);
  const meta = JSON.stringify({ ...(cur ? JSON.parse(cur.meta || '{}') : {}), ...profile.meta });
  if (cur) {
    // Eski devre dışı kayıt aynı external_id'yi tutuyorsa serbest bırak.
    await db
      .prepare(
        "UPDATE accounts SET external_id = external_id || ':old:' || id WHERE platform = ? AND external_id = ? AND id <> ? AND status = 'disabled'",
      )
      .bind(platform, profile.external_id, cur.id)
      .run();
    await db
      .prepare(
        `UPDATE accounts SET external_id = ?, username = ?, display_name = ?, avatar_url = ?, secret_blob = ?, secret_key_version = ?, token_expires_at = ?, refresh_expires_at = ?,
           scopes = ?, status = 'active', last_refreshed_at = ?, last_error = NULL, meta = ?, mode = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(
        profile.external_id,
        profile.username,
        profile.display_name,
        profile.avatar_url,
        blob,
        version,
        tok.token_expires_at,
        tok.refresh_expires_at,
        tok.scopes,
        at,
        meta,
        DEFAULT_MODE[platform],
        at,
        cur.id,
      )
      .run();
    return cur.id;
  }
  const id = newId();
  await db
    .prepare(
      "UPDATE accounts SET external_id = external_id || ':old:' || id WHERE platform = ? AND external_id = ? AND status = 'disabled'",
    )
    .bind(platform, profile.external_id)
    .run();
  await db
    .prepare(
      `INSERT INTO accounts (id, brand_id, platform, mode, external_id, username, display_name, avatar_url, secret_blob, secret_key_version, token_expires_at, refresh_expires_at, scopes, status, last_refreshed_at, meta, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    )
    .bind(
      id,
      brandId,
      platform,
      DEFAULT_MODE[platform],
      profile.external_id,
      profile.username,
      profile.display_name,
      profile.avatar_url,
      blob,
      version,
      tok.token_expires_at,
      tok.refresh_expires_at,
      tok.scopes,
      at,
      meta,
      at,
      at,
    )
    .run();
  return id;
}
