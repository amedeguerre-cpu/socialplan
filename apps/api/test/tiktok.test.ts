import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { PostDTO } from '@socialplan/shared';
import { api, BASE, rawFetch } from './helpers';
import { createBrand, insertAccount, uploadVideo } from './fixtures';
import { drain, queueEnv } from './queue';
import { json, mockServer } from './mockServer';
import { acquireLease } from '../src/lib/posts';
import { hmacSha256Hex } from '../src/lib/crypto';
import { chunkPlan, chunkRange } from '../src/publish/tiktok';
import type { Env } from '../src/env';
import '../src/publish/publishers';

const LIVE: Partial<Env> = {
  DRY_RUN: 'false',
  TIKTOK_CLIENT_KEY: 'ck',
  TIKTOK_CLIENT_SECRET: 'cs',
};
const T = 'open\\.tiktokapis\\.com';
const MB = 1024 * 1024;

async function setup(bytes?: Uint8Array) {
  const b = await createBrand();
  const accountId = await insertAccount(b.id, 'tiktok', {
    tokens: { access_token: 'TT-1', refresh_token: 'TTR-1', open_id: 'open1' },
  });
  const v = await uploadVideo(b.id, { bytes });
  const r = await api('/api/posts/manual', {
    method: 'POST',
    json: { video_id: v.id, platforms: ['tiktok'], date: '2030-01-01', time: '10:00' },
  });
  const [post] = (await r.json()) as PostDTO[];
  await env.DB.prepare('UPDATE posts SET scheduled_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - 1000).toISOString(), post!.id)
    .run();
  const { env: qenv, sent } = queueEnv(LIVE);
  await acquireLease(env.DB, post!.id, 'o', new Date());
  sent.push({ body: { postId: post!.id, traceId: post!.trace_id, leaseOwner: 'o' }, delay: 0 });
  return { post: post!, accountId, qenv, sent, videoId: v.id };
}
const row = (id: string) =>
  env.DB.prepare('SELECT * FROM posts WHERE id = ?')
    .bind(id)
    .first<Record<string, string | number | null>>();

function routes(over: Parameters<typeof mockServer>[0] = {}) {
  return {
    [`POST ${T}/v2/post/publish/creator_info/query/`]: () =>
      json({ data: { max_video_post_duration_sec: 600 }, error: { code: 'ok' } }),
    [`POST ${T}/v2/post/publish/inbox/video/init/`]: () =>
      json({
        data: {
          publish_id: 'v_inbox_1',
          upload_url: 'https://open-upload.tiktokapis.com/upload/?upload_id=1',
        },
        error: { code: 'ok' },
      }),
    'PUT open-upload\\.tiktokapis\\.com/upload/': (c: { headers: Headers }) => {
      const range = c.headers.get('content-range') ?? '';
      const [, , last, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(range) ?? [];
      return new Response(null, { status: Number(last) + 1 === Number(total) ? 201 : 206 });
    },
    [`POST ${T}/v2/post/publish/status/fetch/`]: (_c: unknown, n: number) =>
      json({
        data: { status: n < 2 ? 'PROCESSING_UPLOAD' : 'SEND_TO_USER_INBOX' },
        error: { code: 'ok' },
      }),
    ...over,
  };
}

describe('TikTok parça planı', () => {
  it('5 MB altı tek parça; büyükte floor(size/chunk), son parça kalanı alır', () => {
    expect(chunkPlan(3 * MB)).toEqual({ chunkSize: 3 * MB, totalChunks: 1 });
    const size = 47 * MB + 123;
    const p = chunkPlan(size);
    expect(p).toEqual({ chunkSize: 10 * MB, totalChunks: 4 });
    expect(chunkRange(3, size, p.chunkSize, p.totalChunks)).toEqual({
      first: 30 * MB,
      last: size - 1,
    });
    expect(chunkRange(0, size, p.chunkSize, p.totalChunks)).toEqual({
      first: 0,
      last: 10 * MB - 1,
    });
  });
});

describe('TikTok publisher (taslağa gönder)', () => {
  it('başarı: creator_info → init → parçalar → status → taslağa gönderildi', async () => {
    const m = mockServer(routes());
    const { post, qenv, sent } = await setup();
    await drain(qenv, sent, new Date());
    const r = await row(post.id);
    expect(r?.status).toBe('inbox_sent');
    expect(r?.external_id).toBe('v_inbox_1');
    const init = m.calls.find((c) => c.url.pathname.endsWith('/inbox/video/init/'));
    expect(JSON.parse(init?.body ?? '{}')).toEqual({
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: 1024,
        chunk_size: 1024,
        total_chunk_count: 1,
      },
    });
    expect(init?.headers.get('authorization')).toBe('Bearer TT-1');
    const put = m.calls.find((c) => c.method === 'PUT');
    expect(put?.headers.get('content-range')).toBe('bytes 0-1023/1024');
    expect(put?.bodyBytes).toBe(1024);
  });

  it('çok parçalı yükleme (17 MiB → 1 parça kalan emer) sırayla gönderilir', async () => {
    const m = mockServer(routes());
    const bytes = new Uint8Array(17 * MB);
    const { post, qenv, sent } = await setup(bytes);
    await drain(qenv, sent, new Date());
    expect((await row(post.id))?.status).toBe('inbox_sent');
    const puts = m.calls
      .filter((c) => c.method === 'PUT')
      .map((c) => c.headers.get('content-range'));
    expect(puts).toEqual([`bytes 0-${17 * MB - 1}/${17 * MB}`]);
  });

  it('upload_url süresi dolduysa (403) yeniden init', async () => {
    const bytes = new Uint8Array(25 * MB);
    let put = 0;
    const m = mockServer(
      routes({
        'PUT open-upload\\.tiktokapis\\.com/upload/': (c) => {
          put++;
          if (put === 1) return new Response(null, { status: 403 });
          const [, , last, total] =
            /bytes (\d+)-(\d+)\/(\d+)/.exec(c.headers.get('content-range') ?? '') ?? [];
          return new Response(null, { status: Number(last) + 1 === Number(total) ? 201 : 206 });
        },
      }),
    );
    const { post, qenv, sent } = await setup(bytes);
    await drain(qenv, sent, new Date());
    expect((await row(post.id))?.status).toBe('inbox_sent');
    expect(m.count('/inbox/video/init/')).toBe(2);
  });

  it('429 rate_limit_exceeded → geçici, bekleyip devam', async () => {
    mockServer(
      routes({
        [`POST ${T}/v2/post/publish/inbox/video/init/`]: (_c, n) =>
          n === 1
            ? json({ error: { code: 'rate_limit_exceeded', message: 'too many' } }, 429)
            : json({
                data: {
                  publish_id: 'p2',
                  upload_url: 'https://open-upload.tiktokapis.com/upload/?u=2',
                },
                error: { code: 'ok' },
              }),
      }),
    );
    const { post, qenv, sent } = await setup();
    await drain(qenv, sent, new Date());
    const r = await row(post.id);
    expect(r?.status).toBe('inbox_sent');
    expect(r?.attempt_count).toBe(1);
  });

  it('çok fazla bekleyen taslak → işlem gerekli', async () => {
    mockServer(
      routes({
        [`POST ${T}/v2/post/publish/inbox/video/init/`]: () =>
          json({ error: { code: 'spam_risk_too_many_pending_share', message: 'pending' } }, 403),
      }),
    );
    const { post, qenv, sent } = await setup();
    await drain(qenv, sent, new Date());
    expect((await row(post.id))?.status).toBe('needs_action');
  });

  it('süre creator_info sınırını aşarsa kalıcı hata', async () => {
    mockServer(
      routes({
        [`POST ${T}/v2/post/publish/creator_info/query/`]: () =>
          json({ data: { max_video_post_duration_sec: 10 }, error: { code: 'ok' } }),
      }),
    );
    const { post, qenv, sent } = await setup();
    await drain(qenv, sent, new Date());
    const r = await row(post.id);
    expect(r?.status).toBe('failed');
    expect(r?.last_error_code).toBe('tt_duration');
  });

  it('status FAILED → hata', async () => {
    mockServer(
      routes({
        [`POST ${T}/v2/post/publish/status/fetch/`]: () =>
          json({
            data: { status: 'FAILED', fail_reason: 'file_format_check_failed' },
            error: { code: 'ok' },
          }),
      }),
    );
    const { post, qenv, sent } = await setup();
    await drain(qenv, sent, new Date());
    expect((await row(post.id))?.last_error_message).toContain('file_format_check_failed');
  });

  it('access_token_invalid → refresh → devam', async () => {
    const m = mockServer(
      routes({
        [`POST ${T}/v2/post/publish/creator_info/query/`]: (c) =>
          c.headers.get('authorization') === 'Bearer TT-1'
            ? json({ error: { code: 'access_token_invalid', message: 'expired' } }, 401)
            : json({ data: { max_video_post_duration_sec: 600 }, error: { code: 'ok' } }),
        [`POST ${T}/v2/oauth/token/`]: (c) => {
          expect(new URLSearchParams(c.body).get('grant_type')).toBe('refresh_token');
          return json({
            access_token: 'TT-2',
            refresh_token: 'TTR-2',
            expires_in: 86400,
            refresh_expires_in: 31536000,
            open_id: 'open1',
            scope: 'video.upload',
          });
        },
      }),
    );
    const { post, qenv, sent } = await setup();
    await drain(qenv, sent, new Date());
    expect((await row(post.id))?.status).toBe('inbox_sent');
    expect(m.count('/v2/oauth/token/')).toBe(1);
  });

  it('son parça yanıtı kaybolursa reconcile: status ile kapanır, parça tekrar gönderilmez', async () => {
    let lost = true;
    const m = mockServer(
      routes({
        'PUT open-upload\\.tiktokapis\\.com/upload/': () => {
          if (lost) {
            lost = false;
            throw new Error('bağlantı koptu');
          }
          return new Response(null, { status: 201 });
        },
        [`POST ${T}/v2/post/publish/status/fetch/`]: () =>
          json({ data: { status: 'SEND_TO_USER_INBOX' }, error: { code: 'ok' } }),
      }),
    );
    const { post, qenv, sent } = await setup();
    await drain(qenv, sent, new Date());
    expect((await row(post.id))?.status).toBe('inbox_sent');
    expect(m.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });
});

describe('TikTok webhook', () => {
  async function signed(body: string, secret = 'cs', t = Math.floor(Date.now() / 1000)) {
    return `t=${t},s=${await hmacSha256Hex(secret, `${t}.${body}`)}`;
  }

  it('imzasız / yanlış imzalı istek 401; geçerli publicly_available → yayınlandı (idempotent)', async () => {
    mockServer(routes());
    const { post, qenv, sent } = await setup();
    await drain(qenv, sent, new Date());
    const body = JSON.stringify({
      client_key: 'ck',
      event: 'post.publish.publicly_available',
      create_time: 1,
      user_openid: 'open1',
      content: JSON.stringify({ publish_id: 'v_inbox_1', post_id: '7300000000000000009' }),
    });
    const send = async (sig?: string) =>
      rawFetch(
        new Request(`${BASE}/webhooks/tiktok`, {
          method: 'POST',
          body,
          headers: sig ? { 'tiktok-signature': sig } : {},
        }),
        LIVE,
      );
    expect((await send()).status).toBe(401);
    expect((await send(await signed(body, 'yanlis'))).status).toBe(401);
    expect(
      (await send(await signed(body, 'cs', Math.floor(Date.now() / 1000) - 3600))).status,
    ).toBe(401);
    // aynı publish_id başka testlerden de olabilir: yalnız bu post'u doğrula
    await env.DB.prepare(
      "UPDATE posts SET external_id = 'x-' || id WHERE external_id = 'v_inbox_1' AND id <> ?",
    )
      .bind(post.id)
      .run();
    expect((await send(await signed(body))).status).toBe(200);
    expect((await send(await signed(body))).status).toBe(200);
    const r = await row(post.id);
    expect(r?.status).toBe('published');
    expect(r?.external_url).toBe(
      'https://www.tiktok.com/@kullanici_tiktok/video/7300000000000000009',
    );
    const ev = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM post_events WHERE post_id = ? AND to_status = 'published'",
    )
      .bind(post.id)
      .first<{ n: number }>();
    expect(ev?.n).toBe(1);
  });
});
