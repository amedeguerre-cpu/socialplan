/**
 * Token şifreleme: AES-256-GCM (WebCrypto), kayıt başına 12 bayt rastgele IV.
 * Biçim: "v<sürüm>.<iv b64url>.<şifreli b64url>". TOKEN_ENC_KEY = sürüm 2'den itibaren döndürmeyle artar;
 * şifre çözme mevcut ve önceki (TOKEN_ENC_KEY_PREV) anahtarı dener.
 */
import type { Env } from '../env';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64Decode(s: string): Uint8Array<ArrayBuffer> {
  return b64urlDecode(s.replace(/\+/g, '-').replace(/\//g, '_'));
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function importKey(raw: string): Promise<CryptoKey> {
  let k = keyCache.get(raw);
  if (!k) {
    const bytes = b64Decode(raw.trim());
    if (bytes.length !== 32) throw new Error('TOKEN_ENC_KEY 32 bayt (base64) olmalı');
    k = crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keyCache.set(raw, k);
  }
  return k;
}

/** Anahtar sürümü: TOKEN_ENC_KEY'in önüne "3:" gibi ön ek yazılarak belirtilir; yoksa 1. */
export function parseKeySpec(spec: string): { version: number; raw: string } {
  const m = /^(\d+):(.+)$/.exec(spec.trim());
  return m ? { version: Number(m[1]), raw: m[2] ?? '' } : { version: 1, raw: spec.trim() };
}

export async function encryptJson(
  env: Env,
  value: unknown,
): Promise<{ blob: string; version: number }> {
  const { version, raw } = parseKeySpec(env.TOKEN_ENC_KEY);
  const key = await importKey(raw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(value)),
  );
  return { blob: `v${version}.${b64urlEncode(iv)}.${b64urlEncode(ct)}`, version };
}

export async function decryptJson<T>(env: Env, blob: string): Promise<T> {
  const m = /^v(\d+)\.([^.]+)\.([^.]+)$/.exec(blob);
  if (!m) throw new Error('Geçersiz şifreli kayıt');
  const version = Number(m[1]);
  const specs = [env.TOKEN_ENC_KEY, env.TOKEN_ENC_KEY_PREV]
    .filter((s): s is string => !!s)
    .map(parseKeySpec);
  const ordered = [
    ...specs.filter((s) => s.version === version),
    ...specs.filter((s) => s.version !== version),
  ];
  for (const s of ordered) {
    try {
      const key = await importKey(s.raw);
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64urlDecode(m[2] ?? '') },
        key,
        b64urlDecode(m[3] ?? ''),
      );
      return JSON.parse(dec.decode(pt)) as T;
    } catch {
      /* sonraki anahtarı dene */
    }
  }
  throw new Error('Şifre çözülemedi (anahtar uyuşmuyor)');
}

export async function hmacSha256(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return b64urlEncode(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function sha256Hex(data: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(data));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
