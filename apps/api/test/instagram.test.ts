import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { PostDTO } from '@socialplan/shared';
import { api, BASE } from './helpers';
import { createBrand, insertAccount, uploadVideo } from './fixtures';
import { drain, queueEnv } from './queue';
import { form, json, mockServer } from './mockServer';
import { acquireLease } from '../src/lib/posts';
import { decryptJson } from '../src/lib/crypto';
import type { Env } from '../src/env';
import '../src/publish/publishers';

const LIVE: Partial<Env> = {
  DRY_RUN: 'false',
  R2_ACCESS_KEY_ID: 'AKIA_TEST',
  R2_SECRET_ACCESS_KEY: 'secret_test',
  R2_ACCOUNT_ID: 'acc123',
  R2_BUCKET: 'socialplan-media',
};
const G = 'graph\\.instagram\\.com/v26\\.0';
const IG_USER = '17841400000000001';

async function setup() {
  const b = await createBrand();
  const accountId = await insertAccount(b.id, 'instagram', {
    externalId: `${IG_USER}${b.id.slice(0, 4)}`,
    tokens: { access_token: 'IG-TOKEN-1' },
  });
  const v = await uploadVideo(b.id);
  await api(`/api/videos/${v.id}`, {
    method: 'PATCH',
    json: { description: 'Sabah kahvesi', hashtags: ['kahve'] },
  });
  const r = await api('/api/posts/manual', {
    method: 'POST',
    json: { video_id: v.id, platforms: ['instagram'], date: '2030-01-01', time: '10:00' },
  });
  const [post] = (await r.json()) as PostDTO[];
  await env.DB.prepare('UPDATE posts SET scheduled_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - 1000).toISOString(), post!.id)
    .run();
  const { env: qenv, sent } = queueEnv(LIVE);
  await acquireLease(env.DB, post!.id, 'o', new Date());
  sent.push({ body: { postId: post!.id, traceId: post!.trace_id, leaseOwner: 'o' }, delay: 0 });
  return { post: post!, accountId, qenv, sent };
}

const row = (id: string) =>
  env.DB.prepare('SELECT * FROM posts WHERE id = ?')
    .bind(id)
    .first<Record<string, string | number | null>>();

function happyRoutes(over: Record<string, Parameters<typeof mockServer>[0][string]> = {}) {
  return {
    [`GET ${G}/\\d+[a-z0-9-]*/content_publishing_limit`]: () =>
      json({ data: [{ quota_usage: 3, config: { quota_total: 50, quota_duration: 86400 } }] }),
    [`POST ${G}/\\d+[a-z0-9-]*/media`]: () => json({ id: 'C1' }),
    [`GET ${G}/C1`]: (_c: unknown, n: number) =>
      json({ status_code: n < 2 ? 'IN_PROGRESS' : 'FINISHED', status: '' }),
    [`POST ${G}/\\d+[a-z0-9-]*/media_publish`]: () => json({ id: 'M1' }),
    [`GET ${G}/M1`]: () =>
      json({
        id: 'M1',
        permalink: 'https://www.instagram.com/reel/ABC/',
        media_product_type: 'REELS',
      }),
    ...over,
  };
}

describe('Instagram publisher', () => {
  it('başarı: limit → container → yoklama → publish → permalink', async () => {
    const m = mockServer(happyRoutes());
    const { post, qenv, sent } = await setup();
    await drain(qenv, sent, new Date());
    const r = await row(post.id);
    expect(r?.status).toBe('published');
    expect(r?.external_id).toBe('M1');
    expect(r?.external_url).toBe('https://www.instagram.com/reel/ABC/');
    const create = m.calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/media'));
    const p = form(create?.body ?? '');
    expect(p.get('media_type')).toBe('REELS');
    expect(p.get('share_to_feed')).toBe('true');
    expect(p.get('caption')).toBe('Sabah kahvesi\n\n#kahve');
    expect(p.get('video_url')).toMatch(
      /^https:\/\/acc123\.r2\.cloudflarestorage\.com\/socialplan-media\/videos\/.+X-Amz-Signature=/,
    );
    expect(p.get('cover_url')).toMatch(/thumbs\//);
    expect(create?.headers.get('authorization')).toBe('Bearer IG-TOKEN-1');
    expect(m.count('/media_publish')).toBe(1);
    const acc = await env.DB.prepare(
      'SELECT meta FROM accounts WHERE id = (SELECT account_id FROM posts WHERE id = ?)',
    )
      .bind(post.id)
      .first<{ meta: string }>();
    expect(JSON.parse(acc?.meta ?? '{}').publishing_limit.quota_total).toBe(50);
  });

  it('geçici hata (5xx) sonrası devam eder', async () => {
    mockServer(
      happyRoutes({
        [`POST ${G}/\\d+[a-z0-9-]*/media`]: (_c, n) =>
          n === 1
            ? json({ error: { message: 'Service unavailable', code: 2, is_transient: true } }, 503)
            : json({ id: 'C1' }),
      }),
    );
    const { post, qenv, sent } = await setup();
    await drain(qenv, sent, new Date());
    const r = await row(post.id);
    expect(r?.status).toBe('published');
    expect(r?.attempt_count).toBe(1);
  });

  it('429 → Retry-After / oran sınırı beklemesi', async () => {
    mockServer(
      happyRoutes({
        [`POST ${G}/\\d+[a-z0-9-]*/media`]: () =>
          json({ error: { message: 'rate', code: 4 } }, 429),
      }),
    );
    const { post, qenv, sent } = await setup();
    const { processMessage } = await import('../src/publish/orchestrator');
    await processMessage(qenv, sent.shift()!.body, new Date()); // limit
    await processMessage(qenv, sent.shift()!.body, new Date()); // create → 429
    expect(sent[0]?.delay).toBeGreaterThanOrEqual(600);
    expect((await row(post.id))?.last_error_code).toBe('rate_limited');
  });

  it('kalıcı hata (container ERROR) → hata', async () => {
    mockServer(
      happyRoutes({
        [`GET ${G}/C1`]: () => json({ status_code: 'ERROR', status: 'Error: unsupported codec' }),
      }),
    );
    const { post, qenv, sent } = await setup();
    await drain(qenv, sent, new Date());
    const r = await row(post.id);
    expect(r?.status).toBe('failed');
    expect(r?.last_error_code).toBe('ig_container_error');
  });

  it('token süresi dolması: 190 → yenile → devam', async () => {
    const m = mockServer(
      happyRoutes({
        [`GET ${G}/\\d+[a-z0-9-]*/content_publishing_limit`]: (c) =>
          c.headers.get('authorization') === 'Bearer IG-TOKEN-1'
            ? json({ error: { message: 'expired', code: 190 } }, 400)
            : json({ data: [{ quota_usage: 0, config: { quota_total: 50 } }] }),
        'GET graph\\.instagram\\.com/refresh_access_token': () =>
          json({ access_token: 'IG-TOKEN-2', expires_in: 5184000 }),
      }),
    );
    const { post, accountId, qenv, sent } = await setup();
    await env.DB.prepare('UPDATE accounts SET last_refreshed_at = ? WHERE id = ?')
      .bind(new Date(Date.now() - 2 * 86400_000).toISOString(), accountId)
      .run();
    await drain(qenv, sent, new Date());
    expect((await row(post.id))?.status).toBe('published');
    expect(m.count('refresh_access_token')).toBe(1);
    const acc = await env.DB.prepare('SELECT secret_blob FROM accounts WHERE id = ?')
      .bind(accountId)
      .first<{ secret_blob: string }>();
    expect(
      (await decryptJson<{ access_token: string }>(env as unknown as Env, acc!.secret_blob))
        .access_token,
    ).toBe('IG-TOKEN-2');
  });

  it('token yenileme de başarısız → işlem gerekli', async () => {
    mockServer(
      happyRoutes({
        [`GET ${G}/\\d+[a-z0-9-]*/content_publishing_limit`]: () =>
          json({ error: { message: 'expired', code: 190 } }, 400),
        'GET graph\\.instagram\\.com/refresh_access_token': () =>
          json({ error: { message: 'Session invalidated', code: 190 } }, 400),
      }),
    );
    const { post, accountId, qenv, sent } = await setup();
    await env.DB.prepare('UPDATE accounts SET last_refreshed_at = ? WHERE id = ?')
      .bind(new Date(Date.now() - 2 * 86400_000).toISOString(), accountId)
      .run();
    await drain(qenv, sent, new Date());
    expect((await row(post.id))?.status).toBe('needs_action');
    const acc = await env.DB.prepare('SELECT status FROM accounts WHERE id = ?')
      .bind(accountId)
      .first<{ status: string }>();
    expect(acc?.status).toBe('reconnect');
  });

  it('yarıda kesilip devam: lease devralan yeni sahip container’ı yeniden oluşturmaz', async () => {
    const m = mockServer(happyRoutes());
    const { post, qenv, sent } = await setup();
    const { processMessage } = await import('../src/publish/orchestrator');
    const t0 = new Date();
    await processMessage(qenv, sent.shift()!.body, t0); // limit
    await processMessage(qenv, sent.shift()!.body, t0); // create → poll bekliyor
    sent.length = 0; // mesaj kayboldu
    const later = new Date(t0.getTime() + 20 * 60_000);
    const { reap } = await import('../src/scheduler/cron');
    const { createLogger } = await import('../src/lib/log');
    await reap(qenv, later, createLogger());
    await drain(qenv, sent, later);
    expect((await row(post.id))?.status).toBe('published');
    expect(
      m.calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/media')),
    ).toHaveLength(1);
  });

  it('commit yanıtı kaybolursa: container PUBLISHED + caption eşleşmesi → yayınlandı, ikinci publish yok', async () => {
    let published = false;
    const m = mockServer(
      happyRoutes({
        [`POST ${G}/\\d+[a-z0-9-]*/media_publish`]: () => {
          published = true;
          throw new Error('bağlantı koptu');
        },
        [`GET ${G}/C1`]: (c) =>
          json({
            status_code: published
              ? 'PUBLISHED'
              : c.url.searchParams.get('fields') === 'status_code'
                ? 'FINISHED'
                : 'FINISHED',
          }),
        [`GET ${G}/\\d+[a-z0-9-]*/media`]: () =>
          json({
            data: [
              {
                id: 'M9',
                caption: 'Sabah kahvesi\n\n#kahve',
                timestamp: new Date().toISOString(),
                permalink: 'https://www.instagram.com/reel/Z/',
              },
            ],
          }),
      }),
    );
    const { post, qenv, sent } = await setup();
    await drain(qenv, sent, new Date());
    const r = await row(post.id);
    expect(r?.status).toBe('published');
    expect(r?.external_id).toBe('M9');
    expect(m.count('/media_publish')).toBe(1);
  });

  it('commit belirsiz ve eşleşme yok → işlem gerekli (kör retry yok)', async () => {
    let published = false;
    const m = mockServer(
      happyRoutes({
        [`POST ${G}/\\d+[a-z0-9-]*/media_publish`]: () => {
          published = true;
          return new Response('bad gateway', { status: 502 });
        },
        [`GET ${G}/C1`]: () => json({ status_code: published ? 'PUBLISHED' : 'FINISHED' }),
        [`GET ${G}/\\d+[a-z0-9-]*/media`]: () => json({ data: [] }),
      }),
    );
    const { post, qenv, sent } = await setup();
    await drain(qenv, sent, new Date());
    const r = await row(post.id);
    expect(r?.status).toBe('needs_action');
    expect(r?.last_error_code).toBe('commit_uncertain');
    expect(m.count('/media_publish')).toBe(1);
  });

  it('yayın limiti dolu → 1 saat bekler, sonra devam eder', async () => {
    mockServer(
      happyRoutes({
        [`GET ${G}/\\d+[a-z0-9-]*/content_publishing_limit`]: (_c, n) =>
          json({ data: [{ quota_usage: n === 1 ? 50 : 10, config: { quota_total: 50 } }] }),
      }),
    );
    const { post, qenv, sent } = await setup();
    const { processMessage } = await import('../src/publish/orchestrator');
    await processMessage(qenv, sent.shift()!.body, new Date());
    expect(sent[0]?.delay).toBe(3600);
    await drain(qenv, sent, new Date());
    expect((await row(post.id))?.status).toBe('published');
  });

  it('container EXPIRED → yeniden oluşturulur', async () => {
    const m = mockServer(
      happyRoutes({
        [`POST ${G}/\\d+[a-z0-9-]*/media`]: (_c, n) => json({ id: n === 1 ? 'C0' : 'C1' }),
        [`GET ${G}/C0`]: () => json({ status_code: 'EXPIRED' }),
        [`GET ${G}/C1`]: () => json({ status_code: 'FINISHED' }),
      }),
    );
    const { post, qenv, sent } = await setup();
    await drain(qenv, sent, new Date());
    expect((await row(post.id))?.status).toBe('published');
    expect(
      m.calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/media')),
    ).toHaveLength(2);
  });
});

describe('Instagram OAuth', () => {
  it('state doğrulanır, token şifreli saklanır, hesap bağlanır', async () => {
    const b = await createBrand();
    mockServer({
      'POST api\\.instagram\\.com/oauth/access_token': (c) => {
        const p = form(c.body);
        expect(p.get('code')).toBe('KOD123');
        expect(p.get('redirect_uri')).toBe(`${BASE}/api/oauth/instagram/callback`);
        return json({
          access_token: 'SHORT',
          user_id: 99,
          permissions: 'instagram_business_basic,instagram_business_content_publish',
        });
      },
      'GET graph\\.instagram\\.com/access_token': (c) => {
        expect(c.url.searchParams.get('grant_type')).toBe('ig_exchange_token');
        return json({ access_token: 'LONG-LIVED', expires_in: 5184000 });
      },
      [`GET ${G}/me`]: () =>
        json({ user_id: '1784199', username: 'kafe_tr', name: 'Kafe', account_type: 'BUSINESS' }),
    });
    const ovr = { DRY_RUN: 'false', IG_APP_ID: 'app1', IG_APP_SECRET: 'sec1' };
    const start = await api(`/api/oauth/instagram/start?brand_id=${b.id}`, {}, ovr);
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.get('location') ?? '');
    expect(loc.host).toBe('www.instagram.com');
    expect(loc.searchParams.get('scope')).toContain('instagram_business_content_publish');
    const state = loc.searchParams.get('state') ?? '';
    const bad = await api(`/api/oauth/instagram/callback?state=sahte&code=KOD123`, {}, ovr);
    expect(new URL(bad.headers.get('location') ?? '').searchParams.get('error')).toMatch(
      /Geçersiz/,
    );
    const cb = await api(`/api/oauth/instagram/callback?state=${state}&code=KOD123`, {}, ovr);
    expect(new URL(cb.headers.get('location') ?? '').searchParams.get('connected')).toBe(
      'instagram',
    );
    // state tek kullanımlık
    const again = await api(`/api/oauth/instagram/callback?state=${state}&code=KOD123`, {}, ovr);
    expect(new URL(again.headers.get('location') ?? '').searchParams.get('error')).toBeTruthy();
    const acc = await env.DB.prepare(
      "SELECT * FROM accounts WHERE brand_id = ? AND platform = 'instagram'",
    )
      .bind(b.id)
      .first<{ external_id: string; secret_blob: string; username: string }>();
    expect(acc?.external_id).toBe('1784199');
    expect(acc?.secret_blob).not.toContain('LONG-LIVED');
    expect(
      (await decryptJson<{ access_token: string }>(env as unknown as Env, acc!.secret_blob))
        .access_token,
    ).toBe('LONG-LIVED');
    const list = await (await api(`/api/accounts?brand_id=${b.id}`)).text();
    expect(list).not.toContain('LONG-LIVED');
  });

  it('DRY_RUN açıkken OAuth token takası platforma gitmez', async () => {
    const b = await createBrand();
    const m = mockServer({});
    const ovr = { IG_APP_ID: 'app1', IG_APP_SECRET: 'sec1' };
    const start = await api(`/api/oauth/instagram/start?brand_id=${b.id}`, {}, ovr);
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    const cb = await api(`/api/oauth/instagram/callback?state=${state}&code=X`, {}, ovr);
    expect(new URL(cb.headers.get('location') ?? '').searchParams.get('error')).toMatch(/DRY_RUN/);
    expect(m.calls).toHaveLength(0);
  });

  it('eksik yapılandırmada açık hata', async () => {
    const b = await createBrand();
    const start = await api(
      `/api/oauth/instagram/start?brand_id=${b.id}`,
      {},
      { IG_APP_ID: '', IG_APP_SECRET: '' },
    );
    expect(new URL(start.headers.get('location') ?? '').searchParams.get('error')).toMatch(
      /IG_APP_ID/,
    );
  });
});
