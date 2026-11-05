/** Bağımsız inceleme bulgularının regresyon testleri. */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { PostDTO } from '@socialplan/shared';
import { api, BASE, rawFetch, testEnv } from './helpers';
import { createBrand, insertAccount, uploadVideo } from './fixtures';
import { drain, queueEnv } from './queue';
import { json, mockServer } from './mockServer';
import { claimLease, humanTransition } from '../src/lib/posts';
import { decryptJson, encryptJson, hmacSha256Hex } from '../src/lib/crypto';
import { isAccountAllowed, type Env } from '../src/env';
import { upsertAccount } from '../src/lib/accounts';
import type { PostRow } from '../src/lib/rows';
import '../src/publish/publishers';

const KEY2 = '2:' + btoa(String.fromCharCode(...new Uint8Array(32).fill(11)));
const row = (id: string) =>
  env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first<PostRow>();

async function scheduled(
  platform: 'instagram' | 'youtube' | 'tiktok',
  opts: { externalId?: string; bytes?: Uint8Array } = {},
) {
  const b = await createBrand();
  const accountId = await insertAccount(b.id, platform, { externalId: opts.externalId });
  const v = await uploadVideo(b.id, { bytes: opts.bytes });
  const [post] = (await (
    await api('/api/posts/manual', {
      method: 'POST',
      json: { video_id: v.id, platforms: [platform], date: '2030-01-01', time: '10:00' },
    })
  ).json()) as PostDTO[];
  return { post: post!, accountId, brandId: b.id, videoId: v.id };
}
async function live(postId: string, traceId: string, over: Partial<Env> = {}) {
  await env.DB.prepare('UPDATE posts SET scheduled_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - 1000).toISOString(), postId)
    .run();
  const q = queueEnv({ DRY_RUN: 'false', ...over });
  const seq = (await claimLease(env.DB, postId, 'o', new Date())) as number;
  q.sent.push({ body: { postId, traceId, leaseOwner: 'o', seq }, delay: 0 });
  return q;
}

describe('1 — commit başlamışken iptal', () => {
  it('commit_started_at doluyken iptal 409, toplu iptal reddedilir; yarışta koşullu UPDATE düşer', async () => {
    const { post } = await scheduled('instagram');
    await env.DB.prepare(
      "UPDATE posts SET status = 'processing', commit_started_at = ?, lease_owner = 'x' WHERE id = ?",
    )
      .bind(new Date().toISOString(), post.id)
      .run();
    const r = await api(`/api/posts/${post.id}/cancel`, { method: 'POST' });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe('commit_pending');
    const bulk = (await (
      await api('/api/posts/bulk', { method: 'POST', json: { ids: [post.id], action: 'cancel' } })
    ).json()) as { results: { ok: boolean }[] };
    expect(bulk.results[0]?.ok).toBe(false);
    expect((await row(post.id))?.status).toBe('processing');
    // Yarış: okuma anında commit yok, UPDATE anında var → geçiş yapılmaz
    const stale = { ...(await row(post.id))!, commit_started_at: null };
    expect(
      await humanTransition(env.DB, stale, 't', { to: 'cancelled', requireNoCommit: true }),
    ).toBe(false);
  });
  it('commit başlamamış işlenen post iptal edilebilir', async () => {
    const { post } = await scheduled('instagram');
    await env.DB.prepare("UPDATE posts SET status = 'processing', lease_owner = 'x' WHERE id = ?")
      .bind(post.id)
      .run();
    expect((await api(`/api/posts/${post.id}/cancel`, { method: 'POST' })).status).toBe(200);
  });
});

describe('2 — anahtar döndürme eşzamanlı yenilemeyi ezmez', () => {
  it('okunan blob değiştiyse yazmaz (skipped), yeni token korunur', async () => {
    const b = await createBrand();
    const id = await insertAccount(b.id, 'tiktok', {
      tokens: { access_token: 'ESKI', refresh_token: 'R-ESKI' },
    });
    const base = testEnv({
      TOKEN_ENC_KEY: KEY2,
      TOKEN_ENC_KEY_PREV: (env as unknown as Env).TOKEN_ENC_KEY,
    });
    // DB vekili: döndürmenin koşullu UPDATE'inden hemen önce "eşzamanlı yenileme" yeni token yazar.
    const fresh = await encryptJson(base, { access_token: 'YENI', refresh_token: 'R-YENI' });
    let injected = false;
    const db = new Proxy(env.DB, {
      get(t, k) {
        if (k === 'prepare') {
          return (sql: string) => {
            const stmt = t.prepare(sql);
            if (
              !injected &&
              sql.includes(
                'UPDATE accounts SET secret_blob = ?, secret_key_version = ? WHERE id = ? AND secret_blob = ?',
              )
            ) {
              injected = true;
              return {
                bind: (...args: unknown[]) => ({
                  run: async () => {
                    await t
                      .prepare(
                        'UPDATE accounts SET secret_blob = ?, secret_key_version = 2 WHERE id = ?',
                      )
                      .bind(fresh.blob, id)
                      .run();
                    return stmt.bind(...args).run();
                  },
                }),
              };
            }
            return stmt;
          };
        }
        const v = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as D1Database;
    // Yalnız bu hesabı içeren durum için diğer hesapları önceden güncel anahtarla say
    await env.DB.prepare(
      'UPDATE accounts SET secret_key_version = 2 WHERE id <> ? AND secret_blob LIKE ?',
    )
      .bind(id, 'v2.%')
      .run();
    const r = await api('/api/system/rotate-tokens', { method: 'POST' }, { ...base, DB: db });
    const j = (await r.json()) as { skipped: number };
    expect(injected).toBe(true);
    expect(j.skipped).toBeGreaterThanOrEqual(1);
    const acc = await env.DB.prepare('SELECT secret_blob FROM accounts WHERE id = ?')
      .bind(id)
      .first<{ secret_blob: string }>();
    expect(
      (await decryptJson<{ refresh_token: string }>(base, acc!.secret_blob)).refresh_token,
    ).toBe('R-YENI');
    await env.DB.prepare(
      "UPDATE accounts SET status = 'disabled', secret_blob = NULL WHERE secret_blob LIKE 'v2.%'",
    ).run();
  });
});

describe('3 — TikTok 403 yeniden init döngüsü sınırlı', () => {
  it('parça PUT her zaman 403 → en çok 3 init, sonra işlem gerekli', async () => {
    const m = mockServer({
      'POST open\\.tiktokapis\\.com/v2/post/publish/creator_info/query/': () =>
        json({ data: {}, error: { code: 'ok' } }),
      'POST open\\.tiktokapis\\.com/v2/post/publish/inbox/video/init/': () =>
        json({
          data: { publish_id: 'p', upload_url: 'https://open-upload.tiktokapis.com/upload/?u=1' },
          error: { code: 'ok' },
        }),
      'PUT open-upload\\.tiktokapis\\.com/upload/': () => new Response(null, { status: 403 }),
    });
    const { post } = await scheduled('tiktok');
    const q = await live(post.id, post.trace_id, {
      TIKTOK_CLIENT_KEY: 'k',
      TIKTOK_CLIENT_SECRET: 's',
    });
    await drain(q.env, q.sent, new Date(), 60);
    const r = await row(post.id);
    expect(r?.status).toBe('needs_action');
    expect(r?.last_error_code).toBe('tt_upload_forbidden');
    expect(m.count('/inbox/video/init/')).toBe(3);
  });
});

describe('4 — mime izin listesi ve güvenli medya yanıtı', () => {
  it('text/html video olarak yüklenemez', async () => {
    const b = await createBrand();
    const r = await api('/api/uploads', {
      method: 'POST',
      json: { brand_id: b.id, original_name: 'x.html', mime: 'text/html', size_bytes: 10 },
    });
    expect(r.status).toBe(400);
  });
  it('yüklenen nesnenin türü ne olursa olsun görsel/video güvenli türle, nosniff ve sandbox CSP ile sunulur', async () => {
    const b = await createBrand();
    const v = await uploadVideo(b.id);
    const av = (await (await api(`/api/brands/${b.id}/avatar`, { method: 'POST' })).json()) as {
      url: string;
    };
    expect(
      (
        await api(av.url, {
          method: 'PUT',
          body: '<script>alert(1)</script>',
          headers: { 'content-type': 'text/html' },
        })
      ).status,
    ).toBe(200);
    const res = await api(`/api/media/avatar/${b.id}`);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    const key = (await env.DB.prepare('SELECT r2_key FROM videos WHERE id = ?')
      .bind(v.id)
      .first<{ r2_key: string }>())!.r2_key;
    await env.MEDIA.put(key, '<html>', { httpMetadata: { contentType: 'text/html' } });
    const vr = await api(`/api/media/video/${v.id}`);
    expect(vr.headers.get('content-type')).toBe('video/mp4');
    expect(vr.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('6 — webhook needs_action → published durum makinesinden geçer', () => {
  it('işlem gerekli TikTok post’u webhook ile yayınlandı olur', async () => {
    const { post } = await scheduled('tiktok');
    const pid = `pub-${post.id.slice(0, 8)}`;
    await env.DB.prepare("UPDATE posts SET status = 'needs_action', external_id = ? WHERE id = ?")
      .bind(pid, post.id)
      .run();
    const body = JSON.stringify({
      event: 'post.publish.publicly_available',
      content: JSON.stringify({ publish_id: pid, post_id: '1' }),
    });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},s=${await hmacSha256Hex('cs', `${t}.${body}`)}`;
    const r = await rawFetch(
      new Request(`${BASE}/webhooks/tiktok`, {
        method: 'POST',
        body,
        headers: { 'tiktok-signature': sig },
      }),
      { TIKTOK_CLIENT_SECRET: 'cs' },
    );
    expect(r.status).toBe(200);
    expect((await row(post.id))?.status).toBe('published');
  });
});

describe('7 — "YouTube public yap" güvenlik denetimleri', () => {
  it('kill switch açıkken ve beyaz liste dışında 409, platforma istek yok', async () => {
    const m = mockServer({});
    const { post } = await scheduled('youtube', { externalId: 'UCizinli' });
    await env.DB.prepare(
      "UPDATE posts SET status = 'published', external_id = 'V1', visibility = 'private' WHERE id = ?",
    )
      .bind(post.id)
      .run();
    await env.DB.prepare("UPDATE settings SET value = 'true' WHERE key = 'youtube_audited'").run();
    try {
      const notAllowed = await api(
        `/api/posts/${post.id}/youtube-public`,
        { method: 'POST' },
        { DRY_RUN: 'false', ALLOWED_ACCOUNT_IDS: 'UCbaska' },
      );
      expect(notAllowed.status).toBe(409);
      await env.DB.prepare("UPDATE settings SET value = 'true' WHERE key = 'kill_switch'").run();
      const killed = await api(
        `/api/posts/${post.id}/youtube-public`,
        { method: 'POST' },
        { DRY_RUN: 'false', ALLOWED_ACCOUNT_IDS: 'UCizinli' },
      );
      expect(killed.status).toBe(409);
    } finally {
      await env.DB.prepare(
        "UPDATE settings SET value = 'false' WHERE key IN ('kill_switch','youtube_audited')",
      ).run();
    }
    expect(m.calls).toHaveLength(0);
  });
});

describe('8 — açık post’u olan video silinemez', () => {
  it('işlem gerekli / hata durumundaki post varken silme 409', async () => {
    const { post, videoId } = await scheduled('instagram');
    await env.DB.prepare(
      "UPDATE posts SET status = 'needs_action', commit_started_at = ? WHERE id = ?",
    )
      .bind(new Date().toISOString(), post.id)
      .run();
    expect((await api(`/api/videos/${videoId}`, { method: 'DELETE' })).status).toBe(409);
    await env.DB.prepare("UPDATE posts SET status = 'failed' WHERE id = ?").bind(post.id).run();
    expect((await api(`/api/videos/${videoId}`, { method: 'DELETE' })).status).toBe(409);
  });
});

describe('olası bulgular — sağlamlaştırma', () => {
  it('YouTube 308’de Range yoksa offset 0 kabul edilir (bayt alınmamış)', async () => {
    let first = true;
    const ranges: string[] = [];
    mockServer({
      'POST www\\.googleapis\\.com/upload/youtube/v3/videos': () =>
        new Response(null, {
          status: 200,
          headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos/session/s' },
        }),
      'PUT www\\.googleapis\\.com/upload/youtube/v3/videos/session/.*': (c) => {
        const cr = c.headers.get('content-range') ?? '';
        ranges.push(cr);
        if (cr.startsWith('bytes */')) return new Response(null, { status: 308 });
        if (first) {
          first = false;
          return new Response(null, { status: 308 }); // hiçbir bayt alınmadı
        }
        return json({ id: 'V', status: { privacyStatus: 'private' } }, 201);
      },
    });
    const { post } = await scheduled('youtube', {
      externalId: `UC${crypto.randomUUID().slice(0, 6)}`,
    });
    const ext = (await env.DB.prepare(
      'SELECT external_id FROM accounts WHERE id = (SELECT account_id FROM posts WHERE id = ?)',
    )
      .bind(post.id)
      .first<{ external_id: string }>())!.external_id;
    const q = await live(post.id, post.trace_id, { ALLOWED_ACCOUNT_IDS: ext });
    await drain(q.env, q.sent, new Date());
    expect((await row(post.id))?.status).toBe('published');
    const data = ranges.filter((r) => !r.startsWith('bytes */'));
    expect(data).toEqual(['bytes 0-1023/1024', 'bytes 0-1023/1024']);
  });

  it('Instagram media_publish geçici 4xx (is_transient) → reconcile; PUBLISHED ise ikinci publish yok', async () => {
    let published = false;
    const G = 'graph\\.instagram\\.com/v26\\.0';
    const m = mockServer({
      [`GET ${G}/[^/]+/content_publishing_limit`]: () =>
        json({ data: [{ quota_usage: 0, config: { quota_total: 50 } }] }),
      [`POST ${G}/[^/]+/media`]: () => json({ id: 'C1' }),
      [`GET ${G}/C1`]: () => json({ status_code: published ? 'PUBLISHED' : 'FINISHED' }),
      [`POST ${G}/[^/]+/media_publish`]: () => {
        published = true;
        return json({ error: { message: 'temporary', code: 2, is_transient: true } }, 400);
      },
      [`GET ${G}/[^/]+/media`]: () =>
        json({
          data: [
            {
              id: 'M7',
              caption: 'klip',
              timestamp: new Date().toISOString(),
              permalink: 'https://www.instagram.com/reel/Q/',
            },
          ],
        }),
    });
    const { post } = await scheduled('instagram');
    await env.DB.prepare("UPDATE posts SET caption_snapshot = 'klip' WHERE id = ?")
      .bind(post.id)
      .run();
    const q = await live(post.id, post.trace_id, {
      R2_ACCESS_KEY_ID: 'a',
      R2_SECRET_ACCESS_KEY: 'b',
      R2_ACCOUNT_ID: 'c',
    });
    await drain(q.env, q.sent, new Date());
    expect((await row(post.id))?.status).toBe('published');
    expect((await row(post.id))?.external_id).toBe('M7');
    expect(m.count('/media_publish')).toBe(1);
  });

  it('ALLOWED_ACCOUNT_IDS yalnız platform kimliğiyle eşleşir (iç satır kimliğiyle değil)', () => {
    const e = testEnv({ ALLOWED_ACCOUNT_IDS: 'ic-satir-id' });
    expect(isAccountAllowed(e, { id: 'ic-satir-id', external_id: 'ig123' })).toBe(false);
    expect(
      isAccountAllowed(testEnv({ ALLOWED_ACCOUNT_IDS: 'ig123' }), {
        id: 'x',
        external_id: 'ig123',
      }),
    ).toBe(true);
  });

  it('yeniden bağlamada platform hesabı değişirse bekleyen post’lar işlem gerekli olur', async () => {
    const { post, brandId } = await scheduled('instagram', { externalId: 'ig-eski' });
    await upsertAccount(
      env as unknown as Env,
      brandId,
      'instagram',
      { external_id: 'ig-yeni', username: 'yeni', display_name: null, avatar_url: null, meta: {} },
      {
        tokens: { access_token: 't' },
        token_expires_at: null,
        refresh_expires_at: null,
        scopes: '',
      },
    );
    const r = await row(post.id);
    expect(r?.status).toBe('needs_action');
    expect(r?.last_error_code).toBe('account_changed');
    const ev = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM post_events WHERE post_id = ? AND to_status = 'needs_action'",
    )
      .bind(post.id)
      .first<{ n: number }>();
    expect(ev?.n).toBe(1);
  });

  it('aynı platform hesabıyla yeniden bağlama bekleyen post’lara dokunmaz', async () => {
    const { post, brandId } = await scheduled('instagram', { externalId: 'ig-ayni' });
    await upsertAccount(
      env as unknown as Env,
      brandId,
      'instagram',
      { external_id: 'ig-ayni', username: 'u', display_name: null, avatar_url: null, meta: {} },
      {
        tokens: { access_token: 't2' },
        token_expires_at: null,
        refresh_expires_at: null,
        scopes: '',
      },
    );
    expect((await row(post.id))?.status).toBe('scheduled');
  });
});
