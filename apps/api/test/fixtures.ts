import { env } from 'cloudflare:test';
import type { VideoDTO, VideoMeta } from '@socialplan/shared';
import { api } from './helpers';
import { encryptJson } from '../src/lib/crypto';
import type { Env } from '../src/env';

export const goodMeta = (size: number, over: Partial<VideoMeta> = {}): VideoMeta => ({
  mime: 'video/mp4',
  originalName: 'klip.mp4',
  sizeBytes: size,
  durationMs: 30_000,
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: 'avc1.640028',
  audioCodec: 'mp4a.40.2',
  audioSampleRate: 44100,
  bitrateKbps: 6000,
  moovAtStart: true,
  ...over,
});

let brandSeq = 0;
export async function createBrand(name?: string): Promise<{ id: string; slug: string }> {
  brandSeq++;
  const res = await api('/api/brands', {
    method: 'POST',
    json: {
      name: name ?? `Marka ${brandSeq}`,
      slug: `marka-${brandSeq}-${crypto.randomUUID().slice(0, 6)}`,
    },
  });
  if (res.status !== 201) throw new Error(`brand ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string; slug: string };
}

export async function uploadVideo(
  brandId: string,
  opts: {
    bytes?: Uint8Array;
    name?: string;
    meta?: Partial<VideoMeta>;
    hash?: string;
    aiGenerated?: boolean;
  } = {},
): Promise<VideoDTO> {
  const bytes = opts.bytes ?? new Uint8Array(1024).fill(1);
  const name = opts.name ?? 'klip.mp4';
  const init = await api('/api/uploads', {
    method: 'POST',
    json: {
      brand_id: brandId,
      original_name: name,
      mime: 'video/mp4',
      size_bytes: bytes.length,
      content_hash: opts.hash,
    },
  });
  if (init.status !== 201) throw new Error(`init ${init.status} ${await init.text()}`);
  const j = (await init.json()) as {
    video_id: string;
    part_size: number;
    parts: { partNumber: number; url: string }[];
    thumbnail_url: string;
  };
  const parts: { partNumber: number; etag: string }[] = [];
  for (const p of j.parts) {
    const slice = bytes.slice((p.partNumber - 1) * j.part_size, p.partNumber * j.part_size);
    const r = await api(p.url, { method: 'PUT', body: slice });
    if (r.status !== 200) throw new Error(`part ${r.status} ${await r.text()}`);
    parts.push({ partNumber: p.partNumber, etag: r.headers.get('etag') ?? '' });
  }
  const th = await api(j.thumbnail_url, {
    method: 'PUT',
    body: new Uint8Array([0xff, 0xd8, 0xff]),
    headers: { 'content-type': 'image/jpeg' },
  });
  if (th.status !== 200) throw new Error(`thumb ${th.status}`);
  const done = await api(`/api/uploads/${j.video_id}/complete`, {
    method: 'POST',
    json: {
      parts,
      meta: goodMeta(bytes.length, { originalName: name, ...opts.meta }),
      ai_generated: opts.aiGenerated ?? false,
      thumbnail: true,
    },
  });
  if (done.status !== 200) throw new Error(`complete ${done.status} ${await done.text()}`);
  return (await done.json()) as VideoDTO;
}

/** Doğrudan DB'ye bağlı hesap ekler (OAuth olmadan). */
export async function insertAccount(
  brandId: string,
  platform: 'instagram' | 'youtube' | 'tiktok',
  opts: {
    externalId?: string;
    tokens?: Record<string, unknown>;
    expiresAt?: string | null;
    meta?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const { blob, version } = await encryptJson(
    env as unknown as Env,
    opts.tokens ?? { access_token: 'AT-gizli', refresh_token: 'RT-gizli' },
  );
  await env.DB.prepare(
    `INSERT INTO accounts (id, brand_id, platform, mode, external_id, username, secret_blob, secret_key_version, token_expires_at, scopes, status, meta, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  )
    .bind(
      id,
      brandId,
      platform,
      platform === 'tiktok' ? 'inbox' : 'auto',
      opts.externalId ?? `ext-${id.slice(0, 8)}`,
      `kullanici_${platform}`,
      blob,
      version,
      opts.expiresAt === undefined
        ? new Date(Date.now() + 30 * 86400_000).toISOString()
        : opts.expiresAt,
      'scope.a scope.b',
      JSON.stringify(opts.meta ?? {}),
      now,
      now,
    )
    .run();
  return id;
}
