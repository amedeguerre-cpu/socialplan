/** Faz 9 hata avı: kritik yolların regresyon testleri. */
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { PostDTO } from '@socialplan/shared';
import { app } from '../src/app';
import { api, BASE, installJwks, rawFetch, testEnv } from './helpers';
import { createBrand, insertAccount, uploadVideo } from './fixtures';
import { drain, queueEnv } from './queue';
import { json, mockServer } from './mockServer';
import { claimLease } from '../src/lib/posts';
import { createLogger } from '../src/lib/log';
import { processMessage, refreshAccount } from '../src/publish/orchestrator';
import { overridePublisherForTesting } from '../src/publish/registry';
import { createHttp } from '../src/publish/http';
import { dispatchDue, reap } from '../src/scheduler/cron';
import { refreshDueTokens } from '../src/scheduler/tokens';
import { secondsUntilPacificMidnight } from '../src/publish/youtube';
import { presignGet, presignUploadPart } from '../src/lib/r2';
import { decryptJson } from '../src/lib/crypto';
import { instagramPublisher } from '../src/publish/instagram';
import type { AccountRow } from '../src/lib/rows';
import type { Publisher } from '../src/publish/types';
import '../src/publish/publishers';

const log = createLogger({ test: 'bughunt' });
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

async function duePost(platform: 'instagram' | 'youtube' | 'tiktok' = 'instagram') {
  const b = await createBrand();
  const accountId = await insertAccount(b.id, platform);
  const v = await uploadVideo(b.id);
  const [post] = (await (
    await api('/api/posts/manual', {
      method: 'POST',
      json: { video_id: v.id, platforms: [platform], date: '2030-01-01', time: '10:00' },
    })
  ).json()) as PostDTO[];
  await env.DB.prepare('UPDATE posts SET scheduled_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - 1000).toISOString(), post!.id)
    .run();
  return { post: post!, accountId, brandId: b.id };
}
const row = (id: string) =>
  env.DB.prepare('SELECT * FROM posts WHERE id = ?')
    .bind(id)
    .first<Record<string, string | number | null>>();

function countingPublisher(): Publisher & { steps: number } {
  const p = {
    name: 'instagram' as const,
    steps: 0,
    refreshLeadSeconds: 0,
    validate: () => [],
    initialState: () => ({ step: 'a' }),
    async step(_ctx: unknown, s: { step: string }) {
      p.steps++;
      await new Promise((r) => setTimeout(r, 5));
      return s.step === 'a'
        ? { kind: 'continue' as const, state: { step: 'b' }, waitSeconds: 0 }
        : { kind: 'done' as const, externalId: 'x', url: null };
    },
    reconcile: async () => ({
      kind: 'error' as const,
      class: 'action' as const,
      code: 'commit_uncertain',
      message: '',
    }),
    classifyError: () => ({ class: 'transient' as const, code: 'e', message: 'e' }),
    refreshToken: async () => ({ ok: false as const, permanent: false, message: '' }),
    fetchMetrics: async () => new Map(),
  };
  return p as unknown as Publisher & { steps: number };
}

describe('iki kez yayın olmaz (karşıt senaryolar)', () => {
  it('Queue aynı mesajı iki kez teslim ederse (sıralı ve eşzamanlı) adım bir kez çalışır', async () => {
    const pub = countingPublisher();
    restore = overridePublisherForTesting('instagram', pub);
    const { post } = await duePost();
    const { env: qenv, sent } = queueEnv({ DRY_RUN: 'false' });
    const seq = (await claimLease(env.DB, post.id, 'o', new Date())) as number;
    const msg = { postId: post.id, traceId: post.trace_id, leaseOwner: 'o', seq };
    const [a, b] = await Promise.all([
      processMessage(qenv, msg, new Date()),
      processMessage(qenv, msg, new Date()),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(pub.steps).toBe(1);
    expect(await processMessage(qenv, msg, new Date())).toBeNull(); // geç gelen kopya
    expect(sent).toHaveLength(1);
    const next = sent[0]!.body;
    await Promise.all([
      processMessage(qenv, next, new Date()),
      processMessage(qenv, next, new Date()),
    ]);
    expect(pub.steps).toBe(2);
    expect((await row(post.id))?.status).toBe('published');
  });

  it('cron + şimdi paylaş + reaper aynı anda: tek kilit, tek mesaj', async () => {
    const { post } = await duePost();
    const { env: qenv, sent } = queueEnv();
    const now = new Date();
    const [cron, viaApi, reaped] = await Promise.all([
      dispatchDue(qenv, now, 30, log),
      api(
        `/api/posts/${post.id}/publish-now`,
        { method: 'POST' },
        { PUBLISH_QUEUE: qenv.PUBLISH_QUEUE },
      ),
      reap(qenv, now, log),
    ]);
    void cron;
    void reaped;
    const mine = sent.filter((m) => m.body.postId === post.id);
    const apiOk =
      viaApi.status === 200 && ((await viaApi.json()) as PostDTO).status === 'processing';
    expect(apiOk || mine.length === 1).toBe(true);
    expect(mine.length).toBeLessThanOrEqual(1);
    const events = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM post_events WHERE post_id = ? AND from_status = 'scheduled' AND to_status = 'processing'",
    )
      .bind(post.id)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
  });

  it('lease devralındıktan sonra eski sahibin geciken mesajı düşer', async () => {
    const pub = countingPublisher();
    restore = overridePublisherForTesting('instagram', pub);
    const { post } = await duePost();
    const { env: qenv, sent } = queueEnv({ DRY_RUN: 'false' });
    const t0 = new Date();
    const seq = (await claimLease(env.DB, post.id, 'eski', t0)) as number;
    const later = new Date(t0.getTime() + 16 * 60_000);
    await reap(qenv, later, log);
    const fresh = sent.find((m) => m.body.postId === post.id)!;
    expect(fresh.body.leaseOwner).toMatch(/^reaper:/);
    expect(
      await processMessage(
        qenv,
        { postId: post.id, traceId: post.trace_id, leaseOwner: 'eski', seq },
        later,
      ),
    ).toBeNull();
    expect(pub.steps).toBe(0);
    await drain(qenv, sent, later);
    expect((await row(post.id))?.status).toBe('published');
  });

  it('kaçırılan slot toleransı: tam 30 dk geç → gönderilir, 30 dk + 1 sn → işlem gerekli', async () => {
    const a = await duePost();
    const b = await duePost();
    const now = new Date();
    await env.DB.prepare('UPDATE posts SET scheduled_at = ? WHERE id = ?')
      .bind(new Date(now.getTime() - 30 * 60_000).toISOString(), a.post.id)
      .run();
    await env.DB.prepare('UPDATE posts SET scheduled_at = ? WHERE id = ?')
      .bind(new Date(now.getTime() - 30 * 60_000 - 1000).toISOString(), b.post.id)
      .run();
    const { env: qenv, sent } = queueEnv();
    await dispatchDue(qenv, now, 30, log);
    expect(sent.some((m) => m.body.postId === a.post.id)).toBe(true);
    expect((await row(b.post.id))?.status).toBe('needs_action');
    expect((await row(b.post.id))?.last_error_code).toBe('missed_slot');
  });
});

describe('token yenileme', () => {
  it('iki eşzamanlı yenilemeden yalnız biri platforma gider; diğeri meşgul döner', async () => {
    const b = await createBrand();
    const id = await insertAccount(b.id, 'tiktok', {
      tokens: { access_token: 'A1', refresh_token: 'R1' },
    });
    let calls = 0;
    mockServer({
      'POST open\\.tiktokapis\\.com/v2/oauth/token/': async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return json({
          access_token: 'A2',
          refresh_token: 'R2',
          expires_in: 86400,
          refresh_expires_in: 1e7,
        });
      },
    });
    const e = testEnv({ DRY_RUN: 'false', TIKTOK_CLIENT_KEY: 'k', TIKTOK_CLIENT_SECRET: 's' });
    const acc = (await env.DB.prepare('SELECT * FROM accounts WHERE id = ?')
      .bind(id)
      .first<AccountRow>())!;
    const { tiktokPublisher } = await import('../src/publish/tiktok');
    const http = createHttp(e, log);
    const [r1, r2] = await Promise.all([
      refreshAccount(e, http, log, acc, tiktokPublisher as unknown as Publisher, new Date()),
      refreshAccount(e, http, log, acc, tiktokPublisher as unknown as Publisher, new Date()),
    ]);
    expect(calls).toBe(1);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    expect([r1.busy, r2.busy].filter(Boolean)).toHaveLength(1);
    // Sonraki yenileme, başkası güncellediyse platforma gitmeden yeni token'ı kullanır
    const r3 = await refreshAccount(
      e,
      http,
      log,
      acc,
      tiktokPublisher as unknown as Publisher,
      new Date(),
    );
    expect(r3.ok).toBe(true);
    expect(r3.tokens?.access_token).toBe('A2');
    expect(calls).toBe(1);
    const fresh = (await env.DB.prepare('SELECT * FROM accounts WHERE id = ?')
      .bind(id)
      .first<AccountRow>())!;
    expect(
      (await decryptJson<{ refresh_token: string }>(e, fresh.secret_blob!)).refresh_token,
    ).toBe('R2');
    expect(fresh.refresh_lock_until).toBeNull();
  });

  it('regresyon: cron Instagram token’ını gerçekten yeniler (last_refreshed_at önceden yazılmaz)', async () => {
    const b = await createBrand();
    const id = await insertAccount(b.id, 'instagram', {
      tokens: { access_token: 'IG-OLD' },
      expiresAt: new Date(Date.now() + 5 * 86400_000).toISOString(),
    });
    await env.DB.prepare('UPDATE accounts SET last_refreshed_at = ? WHERE id = ?')
      .bind(new Date(Date.now() - 30 * 86400_000).toISOString(), id)
      .run();
    const m = mockServer({
      'GET graph\\.instagram\\.com/refresh_access_token': () =>
        json({ access_token: 'IG-NEW', expires_in: 5184000 }),
    });
    void instagramPublisher;
    await refreshDueTokens(testEnv({ DRY_RUN: 'false' }), new Date(), log);
    expect(m.count('refresh_access_token')).toBeGreaterThanOrEqual(1);
    const acc = (await env.DB.prepare('SELECT * FROM accounts WHERE id = ?')
      .bind(id)
      .first<AccountRow>())!;
    expect(
      (await decryptJson<{ access_token: string }>(testEnv(), acc.secret_blob!)).access_token,
    ).toBe('IG-NEW');
    expect(new Date(acc.token_expires_at!).getTime()).toBeGreaterThan(Date.now() + 50 * 86400_000);
  });
});

describe('Access her /api ucunda zorunlu', () => {
  it('yönlendirme tablosundaki bütün /api uçları JWT olmadan 401 döner', async () => {
    await installJwks();
    const routes = app.routes.filter((r) => r.path.startsWith('/api/') && r.method !== 'ALL');
    expect(routes.length).toBeGreaterThan(30);
    const failures: string[] = [];
    for (const r of routes) {
      const path = r.path.replace(/:[a-zA-Z_]+/g, 'x');
      const res = await rawFetch(
        new Request(BASE + path, {
          method: r.method,
          headers: { origin: BASE, 'content-type': 'application/json' },
          body: r.method === 'GET' ? undefined : '{}',
        }),
      );
      if (res.status !== 401) failures.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(failures).toEqual([]);
  });
});

describe('YouTube kota günü', () => {
  it('Pasifik gece yarısına kalan süre yaz/kış saatinde doğru', () => {
    expect(secondsUntilPacificMidnight(new Date('2026-07-01T06:00:00Z'))).toBe(3600 + 60);
    expect(secondsUntilPacificMidnight(new Date('2026-12-01T07:00:00Z'))).toBe(3600 + 60);
  });
});

describe('presigned URL süreleri ve multipart', () => {
  const e = testEnv({
    R2_ACCESS_KEY_ID: 'AK',
    R2_SECRET_ACCESS_KEY: 'SK',
    R2_ACCOUNT_ID: 'acc',
    R2_BUCKET: 'b',
  });
  it('parça ve GET URL’leri S3 uç noktasında, 6 saat (≤ 7 gün) geçerli', async () => {
    const part = new URL(await presignUploadPart(e, 'v1', 'videos/x/v1.mp4', 'UP', 3));
    expect(part.host).toBe('acc.r2.cloudflarestorage.com');
    expect(part.searchParams.get('X-Amz-Expires')).toBe('21600');
    expect(part.searchParams.get('partNumber')).toBe('3');
    const get = new URL((await presignGet(e, 'videos/x/v1.mp4', 30 * 86400)) ?? '');
    expect(Number(get.searchParams.get('X-Amz-Expires'))).toBe(7 * 86400);
  });
  it('parça sayısı ceil(size / 16 MiB); son parça kalanı taşır', async () => {
    const b = await createBrand();
    const size = 2 * 16 * 1024 * 1024 + 1;
    const r = await api('/api/uploads', {
      method: 'POST',
      json: { brand_id: b.id, original_name: 'a.mp4', mime: 'video/mp4', size_bytes: size },
    });
    const j = (await r.json()) as { parts: unknown[]; part_size: number };
    expect(j.parts).toHaveLength(3);
    expect(size - 2 * j.part_size).toBe(1);
  });
});

describe('girdi doğrulaması (zod)', () => {
  it('geçersiz girdiler 400 ve DB değişmez', async () => {
    const b = await createBrand();
    const cases: [string, string, unknown][] = [
      [
        'POST',
        '/api/slots',
        { brand_id: b.id, weekday: 1, time_local: '25:00', platforms: ['instagram'] },
      ],
      [
        'POST',
        '/api/slots',
        { brand_id: b.id, weekday: 8, time_local: '10:00', platforms: ['instagram'] },
      ],
      [
        'POST',
        '/api/slots',
        { brand_id: b.id, weekday: 1, time_local: '10:00', platforms: ['twitter'] },
      ],
      [
        'POST',
        '/api/posts/manual',
        { video_id: 'x', platforms: ['instagram'], date: '01.01.2030', time: '10:00' },
      ],
      [
        'POST',
        '/api/posts/bulk',
        { ids: Array.from({ length: 201 }, (_, i) => String(i)), action: 'cancel' },
      ],
      ['POST', '/api/posts/bulk', { ids: ['a'], action: 'sil' }],
      ['PUT', '/api/settings', { retention_days: 0 }],
      ['PUT', '/api/settings', { missed_slot_grace_min: 'çok' }],
      [
        'POST',
        '/api/uploads',
        { brand_id: b.id, original_name: 'a.mp4', mime: 'video/mp4', size_bytes: 6 * 1024 ** 3 },
      ],
      ['POST', '/api/brands', { name: 'x', color: 'kırmızı' }],
      ['PATCH', `/api/brands/${b.id}`, { autofill_days: 999 }],
    ];
    for (const [method, path, body] of cases) {
      const r = await api(path, { method, json: body });
      expect(r.status, `${method} ${path} ${JSON.stringify(body).slice(0, 60)}`).toBe(400);
    }
    const bad = await api('/api/brands', {
      method: 'POST',
      body: '{bozuk',
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);
    const slots = await env.DB.prepare('SELECT COUNT(*) AS n FROM slots WHERE brand_id = ?')
      .bind(b.id)
      .first<{ n: number }>();
    expect(slots?.n).toBe(0);
  });

  it('SQL enjeksiyon denemesi parametre olarak kalır', async () => {
    const r = await api(`/api/posts?q=${encodeURIComponent("' OR 1=1; DROP TABLE posts; --")}`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { total: number }).total).toBe(0);
    const t = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'posts'").first();
    expect(t).toBeTruthy();
  });
});

describe('DRY_RUN', () => {
  it('tam hat (3 platform) boyunca dış istek çıkmaz', async () => {
    const m = mockServer({});
    const ig = await duePost('instagram');
    const yt = await duePost('youtube');
    const tt = await duePost('tiktok');
    const { env: qenv, sent } = queueEnv();
    await dispatchDue(qenv, new Date(), 30, log);
    await drain(qenv, sent, new Date());
    expect((await row(ig.post.id))?.status).toBe('published');
    expect((await row(yt.post.id))?.status).toBe('published');
    expect((await row(tt.post.id))?.status).toBe('inbox_sent');
    expect(m.calls).toEqual([]);
  });
});
