/**
 * OAuth: /api/oauth/:platform/start?brand_id=… → platform yetkilendirme sayfası → /api/oauth/:platform/callback.
 * state tek kullanımlık (oauth_states, 10 dk). Token'lar yalnız şifreli saklanır; panele hiçbir token dönmez.
 */
import { Hono } from 'hono';
import { platformSchema, type Platform } from '@socialplan/shared';
import { b64urlEncode, randomToken } from '../lib/crypto';
import { first, nowIso, run } from '../lib/db';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/errors';
import { upsertAccount } from '../lib/accounts';
import { createHttp } from '../publish/http';
import { oauthAdapter } from '../oauth/registry';
import { OAuthError } from '../oauth/types';
import '../publish/publishers';
import type { Env } from '../env';
import type { AppEnv } from '../types';

export const redirectUri = (env: Env, p: Platform): string =>
  `${new URL(env.APP_BASE_URL).origin}/api/oauth/${p}/callback`;

async function pkceChallenge(verifier: string): Promise<string> {
  return b64urlEncode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}
export { pkceChallenge };

function back(env: Env, params: Record<string, string>): Response {
  const u = new URL('/hesaplar', env.APP_BASE_URL);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return Response.redirect(u.toString(), 302);
}

export const oauthRoutes = new Hono<AppEnv>()
  .get('/:platform/start', async (c) => {
    const parsed = platformSchema.safeParse(c.req.param('platform'));
    if (!parsed.success) throw new HttpError(404, 'not_found', 'Platform bilinmiyor');
    const platform = parsed.data;
    const adapter = oauthAdapter(platform);
    if (!adapter) throw new HttpError(404, 'not_found', 'Platform için OAuth yok');
    const brandId = c.req.query('brand_id') ?? '';
    const brand = await first(c.env.DB, 'SELECT id FROM brands WHERE id = ?', brandId);
    if (!brand) throw new HttpError(404, 'not_found', 'Marka bulunamadı');
    const missing = adapter.missingConfig(c.env);
    if (missing.length) return back(c.env, { error: `Eksik yapılandırma: ${missing.join(', ')}` });
    const state = randomToken(24);
    const verifier = adapter.usesPkce ? randomToken(48) : null;
    await run(
      c.env.DB,
      'INSERT INTO oauth_states (state, platform, brand_id, code_verifier, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      state,
      platform,
      brandId,
      verifier,
      c.get('actor'),
      new Date(Date.now() + 10 * 60_000).toISOString(),
    );
    return c.redirect(
      await adapter.authorizeUrl(c.env, state, verifier, redirectUri(c.env, platform)),
      302,
    );
  })
  .get('/:platform/callback', async (c) => {
    const parsed = platformSchema.safeParse(c.req.param('platform'));
    if (!parsed.success) throw new HttpError(404, 'not_found', 'Platform bilinmiyor');
    const platform = parsed.data;
    const adapter = oauthAdapter(platform);
    if (!adapter) throw new HttpError(404, 'not_found', 'Platform için OAuth yok');
    const state = c.req.query('state') ?? '';
    const code = c.req.query('code');
    const err = c.req.query('error_description') ?? c.req.query('error');
    // state tek kullanımlık: önce sil, sonra doğrula.
    const row = await first<{
      platform: string;
      brand_id: string;
      code_verifier: string | null;
      created_by: string | null;
      expires_at: string;
    }>(
      c.env.DB,
      'DELETE FROM oauth_states WHERE state = ? RETURNING platform, brand_id, code_verifier, created_by, expires_at',
      state,
    );
    if (!row || row.platform !== platform || row.expires_at < nowIso())
      return back(c.env, { error: 'Geçersiz veya süresi dolmuş OAuth isteği; tekrar deneyin' });
    if (row.created_by && row.created_by !== c.get('actor'))
      return back(c.env, { error: 'OAuth isteği başka bir kullanıcı tarafından başlatılmış' });
    if (err || !code)
      return back(c.env, { error: `Yetkilendirme reddedildi: ${err ?? 'kod yok'}` });
    const log = c.get('log').child({ platform });
    const http = createHttp(c.env, log);
    try {
      const tok = await adapter.exchange(
        c.env,
        http,
        log,
        code,
        row.code_verifier,
        redirectUri(c.env, platform),
        new Date(),
      );
      const profile = await adapter.profile(c.env, http, tok.tokens);
      const id = await upsertAccount(c.env, row.brand_id, platform, profile, tok);
      await audit(c.env.DB, c.get('actor'), 'account.connect', 'account', id, {
        platform,
        username: profile.username,
        external_id: profile.external_id,
      });
      return back(c.env, { connected: platform });
    } catch (e) {
      const msg =
        e instanceof OAuthError || e instanceof HttpError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      log.warn('oauth.failed', { err: msg });
      return back(c.env, { error: msg });
    }
  });
