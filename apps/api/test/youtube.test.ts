import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { pacificDay, type PostDTO } from '@socialplan/shared';
import { api } from './helpers';
import { createBrand, insertAccount, uploadVideo } from './fixtures';
import { drain, queueEnv } from './queue';
import { json, mockServer, type Call } from './mockServer';
import { claimLease } from '../src/lib/posts';
import { secondsUntilPacificMidnight, YT_CHUNK } from '../src/publish/youtube';
import type { Env } from '../src/env';
import '../src/publish/publishers';

const U = 'www\\.googleapis\\.com/upload/youtube/v3/videos';
const SESSION = 'www\\.googleapis\\.com/upload/youtube/v3/videos/session/.*';

async function setup(
  opts: {
    bytes?: Uint8Array;
    allowed?: boolean;
    audited?: boolean;
    kids?: boolean;
    ai?: boolean;
  } = {},
) {
  const b = await createBrand();
  const ext = `UC${crypto.randomUUID().slice(0, 10)}`;
  const accountId = await insertAccount(b.id, 'youtube', {
    externalId: ext,
    tokens: { access_token: 'YT-1', refresh_token: 'YTR-1' },
  });
  const v = await uploadVideo(b.id, { bytes: opts.bytes, aiGenerated: opts.ai });
  await api(`/api/videos/${v.id}`, {
    method: 'PATCH',
    json: { title: 'Kahve molası', made_for_kids: opts.kids ?? false },
  });
  const r = await api('/api/posts/manual', {
    method: 'POST',
    json: { video_id: v.id, platforms: ['youtube'], date: '2030-01-01', time: '10:00' },
  });
  const [post] = (await r.json()) as PostDTO[];
  await env.DB.prepare('UPDATE posts SET scheduled_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - 1000).toISOString(), post!.id)
    .run();
  await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'youtube_audited'")
    .bind(opts.audited ? 'true' : 'false')
    .run();
  const LIVE: Partial<Env> = {
    DRY_RUN: 'false',
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsec',
    ALLOWED_ACCOUNT_IDS: opts.allowed === false ? '' : ext,
  };
  const { env: qenv, sent } = queueEnv(LIVE);
  const seq = (await claimLease(env.DB, post!.id, 'o', new Date())) as number;
  sent.push({
    body: { postId: post!.id, traceId: post!.trace_id, leaseOwner: 'o', seq },
    delay: 0,
  });
  return { post: post!, accountId, qenv, sent, ext };
}
const row = (id: string) =>
  env.DB.prepare('SELECT * FROM posts WHERE id = ?')
    .bind(id)
    .first<Record<string, string | number | null>>();

/** Gerçekçi resumable sunucu: alınan baytları sayar, 308 + Range döner. */
function ytServer(
  over: Parameters<typeof mockServer>[0] = {},
  opts: { failChunkAt?: number; loseFinal?: boolean } = {},
) {
  let received = 0;
  let chunkN = 0;
  let finalLost = false;
  const handler = (c: Call) => {
    const cr = c.headers.get('content-range') ?? '';
    const total = Number(cr.split('/')[1]);
    if (cr.startsWith('bytes */')) {
      if (received >= total)
        return json(
          { id: 'VID123', status: { privacyStatus: 'private', uploadStatus: 'uploaded' } },
          200,
        );
      return new Response(null, {
        status: 308,
        headers: received ? { range: `bytes=0-${received - 1}` } : {},
      });
    }
    chunkN++;
    if (opts.failChunkAt === chunkN)
      return json(
        { error: { code: 503, message: 'backend', errors: [{ reason: 'backendError' }] } },
        503,
      );
    const [, a, b] = /bytes (\d+)-(\d+)\//.exec(cr) ?? [];
    if (Number(a) !== received)
      return new Response(null, { status: 308, headers: { range: `bytes=0-${received - 1}` } });
    received = Number(b) + 1;
    if (received >= total) {
      if (opts.loseFinal && !finalLost) {
        finalLost = true;
        throw new Error('yanıt kayboldu');
      }
      return json(
        { id: 'VID123', status: { privacyStatus: 'private', uploadStatus: 'uploaded' } },
        201,
      );
    }
    return new Response(null, { status: 308, headers: { range: `bytes=0-${received - 1}` } });
  };
  return mockServer({
    [`POST ${U}`]: () =>
      new Response(null, {
        status: 200,
        headers: {
          location: 'https://www.googleapis.com/upload/youtube/v3/videos/session/abc?upload_id=xyz',
        },
      }),
    [`PUT ${SESSION}`]: handler,
    ...over,
  });
}

describe('YouTube publisher', () => {
  it('başarı: audit yok → private, madeForKids ve AI alanları açıkça gönderilir', async () => {
    const m = ytServer();
    const { post, qenv, sent } = await setup({ ai: true });
    await drain(qenv, sent, new Date());
    const r = await row(post.id);
    expect(r?.status).toBe('published');
    expect(r?.external_id).toBe('VID123');
    expect(r?.visibility).toBe('private');
    expect(r?.external_url).toBe('https://www.youtube.com/shorts/VID123');
    const init = m.calls.find((c) => c.method === 'POST');
    expect(init?.url.searchParams.get('uploadType')).toBe('resumable');
    expect(init?.headers.get('x-upload-content-length')).toBe('1024');
    const meta = JSON.parse(init?.body ?? '{}');
    expect(meta.status).toEqual({
      privacyStatus: 'private',
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: true,
      embeddable: true,
    });
    expect(meta.snippet.title).toBe('Kahve molası #Shorts');
  });

  it('audit onaylıysa public yüklenir', async () => {
    const m = ytServer();
    const { post, qenv, sent } = await setup({ audited: true, kids: true });
    try {
      await drain(qenv, sent, new Date());
    } finally {
      await env.DB.prepare(
        "UPDATE settings SET value = 'false' WHERE key = 'youtube_audited'",
      ).run();
    }
    expect((await row(post.id))?.status).toBe('published');
    const meta = JSON.parse(m.calls.find((c) => c.method === 'POST')?.body ?? '{}');
    expect(meta.status.privacyStatus).toBe('public');
    expect(meta.status.selfDeclaredMadeForKids).toBe(true);
  });

  it('audit yok + kanal beyaz listede değil → işlem gerekli, istek yok', async () => {
    const m = ytServer();
    const { post, qenv, sent } = await setup({ allowed: false });
    await drain(qenv, sent, new Date());
    const r = await row(post.id);
    expect(r?.status).toBe('needs_action');
    expect(r?.last_error_code).toBe('youtube_not_audited');
    expect(m.calls).toHaveLength(0);
  });

  it('çok parçalı yükleme 8 MiB parçalarla, Content-Range doğru', async () => {
    const m = ytServer();
    const size = 2 * YT_CHUNK + 100;
    const { post, qenv, sent } = await setup({ bytes: new Uint8Array(size) });
    await drain(qenv, sent, new Date());
    expect((await row(post.id))?.status).toBe('published');
    const ranges = m.calls
      .filter((c) => c.method === 'PUT')
      .map((c) => c.headers.get('content-range'));
    expect(ranges).toEqual([
      `bytes 0-${YT_CHUNK - 1}/${size}`,
      `bytes ${YT_CHUNK}-${2 * YT_CHUNK - 1}/${size}`,
      `bytes ${2 * YT_CHUNK}-${size - 1}/${size}`,
    ]);
  });

  it('yarıda kesilip devam: 5xx sonrası boş PUT ile durum sorulur ve kalan baytlardan devam', async () => {
    const m = ytServer({}, { failChunkAt: 2 });
    const size = 2 * YT_CHUNK + 100;
    const { post, qenv, sent } = await setup({ bytes: new Uint8Array(size) });
    await drain(qenv, sent, new Date());
    expect((await row(post.id))?.status).toBe('published');
    const ranges = m.calls
      .filter((c) => c.method === 'PUT')
      .map((c) => c.headers.get('content-range'));
    expect(ranges).toContain(`bytes */${size}`);
    expect(m.calls.filter((c) => c.method === 'POST')).toHaveLength(1); // yeni oturum açılmadı
  });

  it('son parça yanıtı kaybolursa reconcile: boş PUT 200 → yayınlandı, tekrar yükleme yok', async () => {
    const m = ytServer({}, { loseFinal: true });
    const { post, qenv, sent } = await setup();
    await drain(qenv, sent, new Date());
    const r = await row(post.id);
    expect(r?.status).toBe('published');
    expect(r?.external_id).toBe('VID123');
    const puts = m.calls
      .filter((c) => c.method === 'PUT')
      .map((c) => c.headers.get('content-range'));
    expect(puts).toEqual(['bytes 0-1023/1024', 'bytes */1024']);
  });

  it('oturum düştü (404) ve sonuç belirsiz → yüklemeler listesinde eşleşme yoksa işlem gerekli', async () => {
    mockServer({
      [`POST ${U}`]: () =>
        new Response(null, {
          status: 200,
          headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos/session/x' },
        }),
      [`PUT ${SESSION}`]: (c) =>
        c.headers.get('content-range')?.startsWith('bytes */')
          ? new Response(null, { status: 404 })
          : Promise.reject(new Error('koptu')),
      'GET www\\.googleapis\\.com/youtube/v3/channels': () =>
        json({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] }),
      'GET www\\.googleapis\\.com/youtube/v3/playlistItems': () => json({ items: [] }),
    });
    const { post, qenv, sent } = await setup();
    await drain(qenv, sent, new Date());
    const r = await row(post.id);
    expect(r?.status).toBe('needs_action');
    expect(r?.last_error_code).toBe('commit_uncertain');
  });

  it('401 → refresh → devam; invalid_grant → işlem gerekli', async () => {
    const m = ytServer({
      [`POST ${U}`]: (c) =>
        c.headers.get('authorization') === 'Bearer YT-1'
          ? json(
              {
                error: {
                  code: 401,
                  message: 'Invalid Credentials',
                  errors: [{ reason: 'authError' }],
                },
              },
              401,
            )
          : new Response(null, {
              status: 200,
              headers: {
                location: 'https://www.googleapis.com/upload/youtube/v3/videos/session/abc',
              },
            }),
      'POST oauth2\\.googleapis\\.com/token': () =>
        json({ access_token: 'YT-2', expires_in: 3599 }),
    });
    const a = await setup();
    await drain(a.qenv, a.sent, new Date());
    expect((await row(a.post.id))?.status).toBe('published');
    expect(m.count('oauth2.googleapis.com/token')).toBe(1);

    mockServer({
      [`POST ${U}`]: () => json({ error: { code: 401, errors: [{ reason: 'authError' }] } }, 401),
      'POST oauth2\\.googleapis\\.com/token': () =>
        json(
          { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
          400,
        ),
    });
    const b = await setup();
    await drain(b.qenv, b.sent, new Date());
    expect((await row(b.post.id))?.status).toBe('needs_action');
    const acc = await env.DB.prepare('SELECT status, last_error FROM accounts WHERE id = ?')
      .bind(b.accountId)
      .first<{ status: string; last_error: string }>();
    expect(acc?.status).toBe('reconnect');
    expect(acc?.last_error).toMatch(/Testing modunda 7 gün/);
  });

  it('kota dolu → Pasifik gece yarısına ertelenir; quotaExceeded geçici', async () => {
    ytServer();
    const { post, qenv, sent } = await setup();
    const day = pacificDay(new Date());
    await env.DB.prepare(
      "INSERT INTO quota_usage (platform, scope_key, day, bucket, used) VALUES ('youtube','project',?,'uploads',100) ON CONFLICT DO UPDATE SET used = 100",
    )
      .bind(day)
      .run();
    const { processMessage } = await import('../src/publish/orchestrator');
    try {
      await processMessage(qenv, sent.shift()!.body, new Date());
      expect(sent[0]?.delay).toBeGreaterThan(60);
      expect((await row(post.id))?.step).toBe('quota');
    } finally {
      await env.DB.prepare("DELETE FROM quota_usage WHERE platform = 'youtube' AND day = ?")
        .bind(day)
        .run();
    }
    expect(secondsUntilPacificMidnight(new Date('2026-11-05T07:59:00Z'))).toBe(120);
  });

  it('kalıcı hata (invalidTitle) → hata', async () => {
    ytServer({
      [`POST ${U}`]: () =>
        json(
          { error: { code: 400, message: 'bad title', errors: [{ reason: 'invalidTitle' }] } },
          400,
        ),
    });
    const { post, qenv, sent } = await setup();
    await drain(qenv, sent, new Date());
    expect((await row(post.id))?.status).toBe('failed');
  });
});

describe('YouTube OAuth', () => {
  it('PKCE + offline + consent; kanal kimliği kaydedilir', async () => {
    const b = await createBrand();
    mockServer({
      'POST oauth2\\.googleapis\\.com/token': (c) => {
        const p = new URLSearchParams(c.body);
        expect(p.get('code_verifier')).toBeTruthy();
        return json({
          access_token: 'A',
          refresh_token: 'R',
          expires_in: 3599,
          scope: 'youtube.upload',
        });
      },
      'GET www\\.googleapis\\.com/youtube/v3/channels': () =>
        json({ items: [{ id: 'UCkanal1', snippet: { title: 'Kanal', customUrl: '@kanal' } }] }),
    });
    const ovr = { DRY_RUN: 'false', GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec' };
    const start = await api(`/api/oauth/youtube/start?brand_id=${b.id}`, {}, ovr);
    const loc = new URL(start.headers.get('location') ?? '');
    expect(loc.searchParams.get('access_type')).toBe('offline');
    expect(loc.searchParams.get('prompt')).toBe('consent select_account');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    const cb = await api(
      `/api/oauth/youtube/callback?state=${loc.searchParams.get('state')}&code=K`,
      {},
      ovr,
    );
    expect(new URL(cb.headers.get('location') ?? '').searchParams.get('connected')).toBe('youtube');
    const acc = await env.DB.prepare(
      "SELECT external_id, username FROM accounts WHERE brand_id = ? AND platform = 'youtube'",
    )
      .bind(b.id)
      .first<{ external_id: string; username: string }>();
    expect(acc).toEqual({ external_id: 'UCkanal1', username: 'kanal' });
  });
});

describe('Audit sonrası yayınla', () => {
  it('private videoyu videos.update ile public yapar; audit yoksa 409', async () => {
    const m = ytServer({
      'PUT www\\.googleapis\\.com/youtube/v3/videos': (c) => {
        expect(JSON.parse(c.body)).toEqual({
          id: 'VID123',
          status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
        });
        return json({ id: 'VID123', status: { privacyStatus: 'public' } });
      },
    });
    const { post, qenv, sent } = await setup();
    await drain(qenv, sent, new Date());
    expect(
      (await api(`/api/posts/${post.id}/youtube-public`, { method: 'POST' }, { DRY_RUN: 'false' }))
        .status,
    ).toBe(409);
    await env.DB.prepare("UPDATE settings SET value = 'true' WHERE key = 'youtube_audited'").run();
    try {
      const r = await api(
        `/api/posts/${post.id}/youtube-public`,
        { method: 'POST' },
        { DRY_RUN: 'false' },
      );
      expect(r.status).toBe(200);
      expect(((await r.json()) as PostDTO).visibility).toBe('public');
      expect(m.count('PUT www.googleapis.com/youtube/v3/videos')).toBe(1);
    } finally {
      await env.DB.prepare(
        "UPDATE settings SET value = 'false' WHERE key = 'youtube_audited'",
      ).run();
    }
  });
});
