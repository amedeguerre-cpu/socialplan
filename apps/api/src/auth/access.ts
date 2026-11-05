/**
 * Cloudflare Access JWT doğrulaması: Cf-Access-Jwt-Assertion başlığı,
 * https://<takım>.cloudflareaccess.com/cdn-cgi/access/certs JWKS'i ile (jose), iss ve aud kontrolü.
 * ACCESS_DEV_BYPASS yalnız localhost'tan gelen isteklerde ve yerel APP_BASE_URL ile geçerlidir.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { MiddlewareHandler } from 'hono';
import { isLocalBaseUrl, type Env } from '../env';
import type { AppEnv } from '../types';

const jwksCache = new Map<string, JWTVerifyGetKey>();
let jwksOverride: JWTVerifyGetKey | null = null;

/** Testlerde yerel JWKS vermek için. */
export function setJwksForTesting(jwks: JWTVerifyGetKey | null): void {
  jwksOverride = jwks;
}

function teamOrigin(env: Env): string {
  const d = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `https://${d}`;
}

function getJwks(env: Env): JWTVerifyGetKey {
  if (jwksOverride) return jwksOverride;
  const url = `${teamOrigin(env)}/cdn-cgi/access/certs`;
  let j = jwksCache.get(url);
  if (!j) {
    // jose kendi fetch'ini kullanır; JWKS bir platform alanı değildir (DRY_RUN etkilemez).
    j = createRemoteJWKSet(new URL(url), { cooldownDuration: 300_000, cacheMaxAge: 3_600_000 });
    jwksCache.set(url, j);
  }
  return j;
}

export interface AccessIdentity {
  email: string;
  devBypass: boolean;
}

export async function verifyAccess(env: Env, req: Request): Promise<AccessIdentity | null> {
  const host = new URL(req.url).hostname;
  if (
    env.ACCESS_DEV_BYPASS &&
    isLocalBaseUrl(env.APP_BASE_URL) &&
    (host === 'localhost' || host === '127.0.0.1')
  ) {
    return { email: env.ACCESS_DEV_BYPASS, devBypass: true };
  }
  const token = req.headers.get('cf-access-jwt-assertion');
  if (!token || !env.ACCESS_AUD) return null;
  try {
    const { payload } = await jwtVerify(token, getJwks(env), {
      issuer: teamOrigin(env),
      audience: env.ACCESS_AUD,
      algorithms: ['RS256'],
    });
    const email =
      typeof payload.email === 'string'
        ? payload.email
        : typeof payload.sub === 'string'
          ? `service:${payload.sub}`
          : null;
    return email ? { email, devBypass: false } : null;
  } catch {
    return null;
  }
}

export const accessMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = await verifyAccess(c.env, c.req.raw);
  if (!id)
    return c.json(
      { error: 'unauthorized', message: 'Cloudflare Access kimliği doğrulanamadı' },
      401,
    );
  c.set('actor', id.email);
  c.set('devBypass', id.devBypass);
  await next();
};

/** Durum değiştiren isteklerde Origin kontrolü (CSRF). */
export const originMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method;
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
    const origin = c.req.header('origin');
    const self = new URL(c.req.url).origin;
    const allowed = new Set([self, new URL(c.env.APP_BASE_URL).origin]);
    const devLocal =
      c.get('devBypass') && !!origin && ['localhost', '127.0.0.1'].includes(safeHost(origin));
    if (!origin || (!allowed.has(origin) && !devLocal)) {
      return c.json({ error: 'bad_origin', message: 'İstek kaynağı (Origin) reddedildi' }, 403);
    }
  }
  await next();
};

function safeHost(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}
