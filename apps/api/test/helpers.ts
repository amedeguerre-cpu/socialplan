import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWK } from 'jose';
import { app } from '../src/app';
import { setJwksForTesting } from '../src/auth/access';
import type { Env } from '../src/env';

export const BASE = 'https://plan.example.com';
export const ISS = 'https://test-team.cloudflareaccess.com';

let keys: { privateKey: CryptoKey; jwk: JWK } | null = null;

export async function accessKeys(): Promise<{ privateKey: CryptoKey; jwk: JWK }> {
  if (!keys) {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-kid', alg: 'RS256', use: 'sig' };
    keys = { privateKey, jwk };
  }
  return keys;
}

export async function installJwks(): Promise<void> {
  const k = await accessKeys();
  setJwksForTesting(createLocalJWKSet({ keys: [k.jwk] }));
}

export async function signAccessJwt(
  opts: { aud?: string; iss?: string; email?: string; key?: CryptoKey; expSec?: number } = {},
): Promise<string> {
  const k = await accessKeys();
  return new SignJWT({ email: opts.email ?? 'ekip@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
    .setIssuer(opts.iss ?? ISS)
    .setAudience(opts.aud ?? 'test-aud')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (opts.expSec ?? 600))
    .sign(opts.key ?? k.privateKey);
}

export function testEnv(over: Partial<Env> = {}): Env {
  return { ...(env as unknown as Env), ...over };
}

/** Access JWT'li API isteği. */
export async function api(
  path: string,
  init: RequestInit & { json?: unknown } = {},
  envOver: Partial<Env> = {},
): Promise<Response> {
  await installJwks();
  const headers = new Headers(init.headers);
  if (!headers.has('cf-access-jwt-assertion'))
    headers.set('cf-access-jwt-assertion', await signAccessJwt());
  if (init.method && init.method !== 'GET' && !headers.has('origin')) headers.set('origin', BASE);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(BASE + path, { ...init, headers, body }),
    testEnv(envOver),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

export async function rawFetch(req: Request, envOver: Partial<Env> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(req, testEnv(envOver), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
