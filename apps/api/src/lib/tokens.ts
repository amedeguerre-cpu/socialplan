/** Hesap token'ları — yalnız şifreli saklanır, DTO'ya ve loglara girmez. */
import type { Env } from '../env';
import { decryptJson, encryptJson } from './crypto';
import { nowIso, run } from './db';
import type { AccountRow } from './rows';

export interface AccountTokens {
  access_token: string;
  refresh_token?: string;
  /** Platforma özgü ek alanlar (ör. open_id). */
  [k: string]: unknown;
}

export async function readTokens(env: Env, account: AccountRow): Promise<AccountTokens> {
  if (!account.secret_blob) throw new Error('Hesabın token kaydı yok');
  return decryptJson<AccountTokens>(env, account.secret_blob);
}

export interface TokenUpdate {
  tokens: AccountTokens;
  token_expires_at: string | null;
  refresh_expires_at?: string | null;
  scopes?: string;
}

export async function saveTokens(
  env: Env,
  accountId: string,
  u: TokenUpdate,
  now = new Date(),
): Promise<void> {
  const { blob, version } = await encryptJson(env, u.tokens);
  await run(
    env.DB,
    `UPDATE accounts SET secret_blob = ?, secret_key_version = ?, token_expires_at = ?, refresh_expires_at = COALESCE(?, refresh_expires_at),
       scopes = COALESCE(?, scopes), status = 'active', last_refreshed_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
    blob,
    version,
    u.token_expires_at,
    u.refresh_expires_at ?? null,
    u.scopes ?? null,
    nowIso(now),
    nowIso(now),
    accountId,
  );
}

export async function markReconnect(env: Env, accountId: string, reason: string): Promise<void> {
  await run(
    env.DB,
    "UPDATE accounts SET status = 'reconnect', last_error = ?, updated_at = ? WHERE id = ?",
    reason.slice(0, 500),
    nowIso(),
    accountId,
  );
}
