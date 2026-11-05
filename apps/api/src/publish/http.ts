/**
 * TEK dış HTTP istemcisi. Worker'daki tüm dış istekler buradan geçer (ESLint doğrudan fetch'i yasaklar).
 * - DRY_RUN açıkken platform alanlarına giden her isteği reddeder ve loglar.
 * - Log'da Authorization / access_token / refresh_token / code / client_secret maskelenir.
 * - Testler `setTransportForTesting` ile sahte taşıyıcı verir.
 */
import { isDryRun, type Env } from '../env';
import { maskString, type Logger } from '../lib/log';

export type Transport = (req: Request) => Promise<Response>;

// eslint-disable-next-line no-restricted-globals -- tek izinli fetch kullanımı
const defaultTransport: Transport = (req) => fetch(req);
let transport: Transport = defaultTransport;

export function setTransportForTesting(t: Transport | null): void {
  transport = t ?? defaultTransport;
}

const PLATFORM_HOST_SUFFIXES = [
  'instagram.com',
  'facebook.com',
  'fbcdn.net',
  'googleapis.com',
  'google.com',
  'youtube.com',
  'tiktok.com',
  'tiktokapis.com',
];

export function isPlatformHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return PLATFORM_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

export class DryRunBlockedError extends Error {
  readonly code = 'dry_run_blocked';
  constructor(url: string) {
    super(`DRY_RUN açık: platform isteği engellendi (${maskString(url)})`);
  }
}

export class NetworkError extends Error {
  readonly code = 'network_error';
}

export interface HttpMeta {
  purpose: string;
  platform?: string;
}

export interface HttpClient {
  fetch(url: string, init: RequestInit, meta: HttpMeta): Promise<Response>;
}

export function createHttp(env: Env, log: Logger): HttpClient {
  return {
    async fetch(url, init, meta) {
      const u = new URL(url);
      const method = (init.method ?? 'GET').toUpperCase();
      if (isDryRun(env) && isPlatformHost(u.hostname)) {
        log.warn('http.blocked_dry_run', {
          method,
          url: u.origin + u.pathname,
          purpose: meta.purpose,
          platform: meta.platform,
        });
        throw new DryRunBlockedError(url);
      }
      const started = Date.now();
      let res: Response;
      try {
        res = await transport(new Request(url, init));
      } catch (e) {
        log.warn('http.network_error', {
          method,
          url: u.origin + u.pathname,
          purpose: meta.purpose,
          err: String(e),
        });
        throw new NetworkError(e instanceof Error ? e.message : String(e));
      }
      log.info('http.request', {
        method,
        url: u.origin + u.pathname,
        status: res.status,
        ms: Date.now() - started,
        purpose: meta.purpose,
        platform: meta.platform,
      });
      return res;
    },
  };
}

/** JSON gövdeyi güvenle oku (gövde boş/bozuksa null). */
export async function readJson<T = Record<string, unknown>>(res: Response): Promise<T | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function retryAfterSeconds(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - Date.now()) / 1000)) : undefined;
}
