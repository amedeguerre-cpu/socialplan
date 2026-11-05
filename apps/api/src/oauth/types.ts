import type { Platform } from '@socialplan/shared';
import type { Env } from '../env';
import type { Logger } from '../lib/log';
import type { AccountTokens } from '../lib/tokens';
import type { HttpClient } from '../publish/http';

export interface OAuthTokenResult {
  tokens: AccountTokens;
  token_expires_at: string | null;
  refresh_expires_at: string | null;
  scopes: string;
}

export interface OAuthProfile {
  external_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  meta: Record<string, unknown>;
}

export interface OAuthAdapter {
  platform: Platform;
  /** Ortamda gerekli değişkenler tanımlı mı? (eksik olanların adları) */
  missingConfig(env: Env): string[];
  authorizeUrl(
    env: Env,
    state: string,
    codeVerifier: string | null,
    redirectUri: string,
  ): Promise<string>;
  usesPkce: boolean;
  exchange(
    env: Env,
    http: HttpClient,
    log: Logger,
    code: string,
    codeVerifier: string | null,
    redirectUri: string,
    now: Date,
  ): Promise<OAuthTokenResult>;
  profile(env: Env, http: HttpClient, tokens: AccountTokens): Promise<OAuthProfile>;
}

export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const expiresAt = (now: Date, sec: number | undefined | null): string | null =>
  typeof sec === 'number' && Number.isFinite(sec) && sec > 0
    ? new Date(now.getTime() + sec * 1000).toISOString()
    : null;
