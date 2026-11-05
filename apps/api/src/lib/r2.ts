/**
 * R2 presigned URL'ler. Binding presign yapamaz → aws4fetch + R2 S3 API anahtarı (S3 uç noktası
 * <hesap>.r2.cloudflarestorage.com, en çok 7 gün). Anahtar yoksa (yerel geliştirme) URL'ler Worker'ın
 * kendi /api/uploads/local/* uçlarına HMAC imzalı olarak üretilir ve yükleme binding ile yerel R2'ye yazılır.
 */
import { AwsClient } from 'aws4fetch';
import type { Env } from '../env';
import { hmacSha256, timingSafeEqual } from './crypto';

export const PART_SIZE = 16 * 1024 * 1024; // 16 MiB (R2: 5 MiB–5 GiB, son hariç eşit)
const MAX_EXPIRY = 7 * 24 * 3600;

export function hasS3Credentials(env: Env): boolean {
  return !!(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ACCOUNT_ID);
}

function s3ObjectUrl(env: Env, key: string): URL {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${path}`);
}

async function signS3(
  env: Env,
  url: URL,
  method: string,
  expiresSec: number,
  headers?: Record<string, string>,
): Promise<string> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
    service: 's3',
    region: 'auto',
  });
  url.searchParams.set('X-Amz-Expires', String(Math.min(expiresSec, MAX_EXPIRY)));
  const signed = await client.sign(new Request(url, { method, headers }), {
    aws: { signQuery: true },
  });
  return signed.url;
}

async function localToken(env: Env, payload: string): Promise<string> {
  return hmacSha256(`local-upload:${env.TOKEN_ENC_KEY}`, payload);
}

export async function verifyLocalToken(
  env: Env,
  payload: string,
  token: string,
  exp: number,
): Promise<boolean> {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  return timingSafeEqual(await localToken(env, `${payload}:${exp}`), token);
}

async function localUrl(
  env: Env,
  path: string,
  payload: string,
  expiresSec: number,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + expiresSec;
  const t = await localToken(env, `${payload}:${exp}`);
  return `${path}${path.includes('?') ? '&' : '?'}exp=${exp}&t=${t}`;
}

export async function presignUploadPart(
  env: Env,
  videoId: string,
  key: string,
  uploadId: string,
  partNumber: number,
): Promise<string> {
  if (!hasS3Credentials(env)) {
    return localUrl(
      env,
      `/api/uploads/local/${videoId}/parts/${partNumber}`,
      `part:${videoId}:${partNumber}`,
      6 * 3600,
    );
  }
  const url = s3ObjectUrl(env, key);
  url.searchParams.set('partNumber', String(partNumber));
  url.searchParams.set('uploadId', uploadId);
  return signS3(env, url, 'PUT', 6 * 3600);
}

/** Tek nesne PUT (thumbnail, marka avatarı). */
export async function presignPut(env: Env, key: string): Promise<string> {
  if (!hasS3Credentials(env)) {
    return localUrl(
      env,
      `/api/uploads/local/object?key=${encodeURIComponent(key)}`,
      `put:${key}`,
      3600,
    );
  }
  return signS3(env, s3ObjectUrl(env, key), 'PUT', 3600);
}

/**
 * Platformun videoyu çekmesi için süreli GET URL (Instagram video_url).
 * TODO(doğrula): Meta'nın query string'li, süreli R2 URL'sini kabul ettiği belgelenmemiş.
 */
export async function presignGet(
  env: Env,
  key: string,
  expiresSec = 6 * 3600,
): Promise<string | null> {
  if (!hasS3Credentials(env)) return null;
  return signS3(env, s3ObjectUrl(env, key), 'GET', expiresSec);
}

export function videoKey(brandId: string, videoId: string, originalName: string): string {
  const ext = (originalName.toLowerCase().match(/\.(mp4|mov|webm|m4v)$/)?.[1] ?? 'mp4').replace(
    'm4v',
    'mp4',
  );
  return `videos/${brandId}/${videoId}.${ext}`;
}

export const thumbKey = (brandId: string, videoId: string): string =>
  `thumbs/${brandId}/${videoId}.jpg`;
export const avatarKey = (brandId: string): string => `avatars/${brandId}.jpg`;
