import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { PostDTO } from '@socialplan/shared';
import { api } from './helpers';
import { createBrand, insertAccount, uploadVideo } from './fixtures';
import { drain, queueEnv } from './queue';
import { overridePublisherForTesting } from '../src/publish/registry';
import { processMessage } from '../src/publish/orchestrator';
import { acquireLease } from '../src/lib/posts';
import { setTransportForTesting } from '../src/publish/http';
import {
  AUTH_EXPIRED,
  type BaseState,
  type Publisher,
  type StepResult,
} from '../src/publish/types';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

/** Senaryolu sahte publisher. */
function fakePublisher(
  script: ((s: BaseState, ctx: Parameters<Publisher['step']>[0]) => Promise<StepResult>)[],
  opts: Partial<Publisher> = {},
): Publisher & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    name: 'instagram',
    refreshLeadSeconds: 0,
    validate: () => [],
    initialState: () => ({ step: 'start' }),
    async step(ctx, s) {
      calls.push(`step:${s.step}`);
      const fn = script[Math.min(i++, script.length - 1)];
      return fn
        ? fn(s, ctx)
        : { kind: 'error', class: 'permanent', code: 'no_script', message: 'senaryo yok' };
    },
    async reconcile(_ctx, s) {
      calls.push(`reconcile:${s.step}`);
      return { kind: 'error', class: 'action', code: 'commit_uncertain', message: 'belirsiz' };
    },
    classifyError: (e) => ({ class: 'transient', code: 'network_error', message: String(e) }),
    refreshToken: async () => ({ ok: false, permanent: true, message: 'iptal edilmiş token' }),
    fetchMetrics: async () => new Map(),
    ...opts,
    calls,
  } as Publisher & { calls: string[] };
}

async function scheduledPost(): Promise<{ post: PostDTO; accountId: string }> {
  const b = await createBrand();
  const accountId = await insertAccount(b.id, 'instagram');
  const v = await uploadVideo(b.id);
  const r = await api('/api/posts/manual', {
    method: 'POST',
    json: { video_id: v.id, platforms: ['instagram'], date: '2030-01-01', time: '10:00' },
  });
  const [post] = (await r.json()) as PostDTO[];
  // zamanı şimdi yap
  await env.DB.prepare('UPDATE posts SET scheduled_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - 1000).toISOString(), post!.id)
    .run();
  return { post: post!, accountId };
}

async function start(postId: string, traceId: string) {
  const { env: qenv, sent } = queueEnv({ DRY_RUN: 'false' });
  const owner = 'test-owner';
  expect(await acquireLease(env.DB, postId, owner, new Date())).toBe(true);
  sent.push({ body: { postId, traceId, leaseOwner: owner }, delay: 0 });
  return { qenv, sent };
}

const row = (id: string) =>
  env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first<Record<string, unknown>>();

describe('orkestratör', () => {
  it('adımlar arası durum D1’e yazılır ve delaySeconds ile devam eder', async () => {
    const pub = fakePublisher([
      async () => ({ kind: 'continue', state: { step: 'upload', n: 1 }, waitSeconds: 30 }),
      async (s) => ({ kind: 'continue', state: { ...s, step: 'poll' }, waitSeconds: 20 }),
      async () => ({ kind: 'done', externalId: 'm1', url: 'https://www.instagram.com/reel/x/' }),
    ]);
    restore = overridePublisherForTesting('instagram', pub);
    const { post } = await scheduledPost();
    const { qenv, sent } = await start(post.id, post.trace_id);
    const first = sent.shift()!;
    await processMessage(qenv, first.body, new Date());
    expect(sent[0]?.delay).toBe(30);
    const r = await row(post.id);
    expect(JSON.parse(String(r?.platform_state))).toEqual({ step: 'upload', n: 1 });
    await drain(qenv, sent, new Date());
    const done = await row(post.id);
    expect(done?.status).toBe('published');
    expect(done?.external_id).toBe('m1');
    expect(pub.calls).toEqual(['step:start', 'step:upload', 'step:poll']);
  });

  it('geçici hata: 1/5/25 dk geri çekilme, 3 tekrardan sonra hata', async () => {
    const pub = fakePublisher([
      async () => ({ kind: 'error', class: 'transient', code: 'http_503', message: 'Servis yok' }),
    ]);
    restore = overridePublisherForTesting('instagram', pub);
    const { post } = await scheduledPost();
    const { qenv, sent } = await start(post.id, post.trace_id);
    const delays: number[] = [];
    let now = new Date();
    for (let i = 0; i < 4; i++) {
      const m = sent.shift()!;
      now = new Date(now.getTime() + m.delay * 1000);
      await processMessage(qenv, m.body, now);
      if (sent[0]) delays.push(sent[0].delay);
    }
    expect(delays).toHaveLength(3);
    expect(delays[0]).toBeGreaterThanOrEqual(60);
    expect(delays[0]).toBeLessThanOrEqual(72);
    expect(delays[1]).toBeGreaterThanOrEqual(300);
    expect(delays[2]).toBeGreaterThanOrEqual(1500);
    const r = await row(post.id);
    expect(r?.status).toBe('failed');
    expect(r?.last_error_code).toBe('http_503');
  });

  it("429 Retry-After'a uyulur", async () => {
    const pub = fakePublisher([
      async () => ({
        kind: 'error',
        class: 'transient',
        code: 'rate_limited',
        message: '429',
        retryAfterSec: 900,
      }),
    ]);
    restore = overridePublisherForTesting('instagram', pub);
    const { post } = await scheduledPost();
    const { qenv, sent } = await start(post.id, post.trace_id);
    await processMessage(qenv, sent.shift()!.body, new Date());
    expect(sent[0]?.delay).toBe(900);
  });

  it('kalıcı hata → hata; action → işlem gerekli', async () => {
    restore = overridePublisherForTesting(
      'instagram',
      fakePublisher([
        async () => ({ kind: 'error', class: 'permanent', code: 'bad_video', message: 'x' }),
      ]),
    );
    const a = await scheduledPost();
    const sa = await start(a.post.id, a.post.trace_id);
    await drain(sa.qenv, sa.sent, new Date());
    expect((await row(a.post.id))?.status).toBe('failed');
    restore();
    restore = overridePublisherForTesting(
      'instagram',
      fakePublisher([
        async () => ({ kind: 'error', class: 'action', code: 'account_restricted', message: 'x' }),
      ]),
    );
    const b = await scheduledPost();
    const sb = await start(b.post.id, b.post.trace_id);
    await drain(sb.qenv, sb.sent, new Date());
    expect((await row(b.post.id))?.status).toBe('needs_action');
  });

  it('401 → token yenilenir ve adım devam eder', async () => {
    let n = 0;
    const pub = fakePublisher(
      [
        async (_s, ctx) => {
          n++;
          const t = await ctx.tokens();
          if (t.access_token === 'AT-gizli')
            return { kind: 'error', class: 'transient', code: AUTH_EXPIRED, message: '401' };
          return { kind: 'done', externalId: 'ok', url: null };
        },
      ],
      {
        refreshToken: async () => ({
          ok: true,
          update: {
            tokens: { access_token: 'AT-yeni' },
            token_expires_at: '2031-01-01T00:00:00.000Z',
          },
        }),
      },
    );
    restore = overridePublisherForTesting('instagram', pub);
    const { post, accountId } = await scheduledPost();
    const s = await start(post.id, post.trace_id);
    await drain(s.qenv, s.sent, new Date());
    expect((await row(post.id))?.status).toBe('published');
    expect(n).toBe(2);
    const acc = await env.DB.prepare('SELECT token_expires_at, status FROM accounts WHERE id = ?')
      .bind(accountId)
      .first<{ token_expires_at: string; status: string }>();
    expect(acc?.token_expires_at).toBe('2031-01-01T00:00:00.000Z');
  });

  it('401 ve yenileme de başarısız → işlem gerekli, hesap yeniden bağlanmalı', async () => {
    restore = overridePublisherForTesting(
      'instagram',
      fakePublisher([
        async () => ({ kind: 'error', class: 'transient', code: AUTH_EXPIRED, message: '401' }),
      ]),
    );
    const { post, accountId } = await scheduledPost();
    const s = await start(post.id, post.trace_id);
    await drain(s.qenv, s.sent, new Date());
    const r = await row(post.id);
    expect(r?.status).toBe('needs_action');
    expect(r?.last_error_code).toBe('token_refresh_failed');
    const acc = await env.DB.prepare('SELECT status FROM accounts WHERE id = ?')
      .bind(accountId)
      .first<{ status: string }>();
    expect(acc?.status).toBe('reconnect');
  });

  it('commit yanıtı kaybolursa kör retry yok: reconcile çağrılır, belirsizse işlem gerekli', async () => {
    const pub = fakePublisher([
      async (s, ctx) => {
        await ctx.beginCommit({ ...s, step: 'publish' });
        throw new Error('bağlantı koptu');
      },
    ]);
    restore = overridePublisherForTesting('instagram', pub);
    const { post } = await scheduledPost();
    const s = await start(post.id, post.trace_id);
    await drain(s.qenv, s.sent, new Date());
    expect(pub.calls).toEqual(['step:start', 'reconcile:publish']);
    const r = await row(post.id);
    expect(r?.status).toBe('needs_action');
    expect(r?.last_error_code).toBe('commit_uncertain');
  });

  it('reconcile platformda yayını bulursa yayınlandı olur', async () => {
    const pub = fakePublisher(
      [
        async (s, ctx) => {
          await ctx.beginCommit({ ...s, step: 'publish' });
          throw new Error('zaman aşımı');
        },
      ],
      { reconcile: async () => ({ kind: 'done', externalId: 'bulundu', url: 'https://x/' }) },
    );
    restore = overridePublisherForTesting('instagram', pub);
    const { post } = await scheduledPost();
    const s = await start(post.id, post.trace_id);
    await drain(s.qenv, s.sent, new Date());
    const r = await row(post.id);
    expect(r?.status).toBe('published');
    expect(r?.external_id).toBe('bulundu');
    expect(r?.commit_started_at).toBeNull();
  });

  it('yarıda iptal edilen post’a sonuç yazılmaz', async () => {
    const pub = fakePublisher([
      async (_s, ctx) => {
        await env.DB.prepare("UPDATE posts SET status = 'cancelled' WHERE id = ?")
          .bind(ctx.post.id)
          .run();
        return { kind: 'done', externalId: 'x', url: null };
      },
    ]);
    restore = overridePublisherForTesting('instagram', pub);
    const { post } = await scheduledPost();
    const s = await start(post.id, post.trace_id);
    await drain(s.qenv, s.sent, new Date());
    expect((await row(post.id))?.status).toBe('cancelled');
  });

  it('kill switch adım sırasında açılırsa dış çağrı yapılmaz → işlem gerekli', async () => {
    const calls: string[] = [];
    setTransportForTesting(async (req) => {
      calls.push(req.url);
      return new Response('{}');
    });
    const pub = fakePublisher([
      async (_s, ctx) => {
        await env.DB.prepare("UPDATE settings SET value = 'true' WHERE key = 'kill_switch'").run();
        await ctx.http.fetch(
          'https://graph.instagram.com/v26.0/me',
          { method: 'GET' },
          { purpose: 'test' },
        );
        return { kind: 'done', externalId: 'x', url: null };
      },
    ]);
    restore = overridePublisherForTesting('instagram', pub);
    const { post } = await scheduledPost();
    const s = await start(post.id, post.trace_id);
    try {
      await drain(s.qenv, s.sent, new Date());
    } finally {
      await env.DB.prepare("UPDATE settings SET value = 'false' WHERE key = 'kill_switch'").run();
    }
    const r = await row(post.id);
    expect(r?.status).toBe('needs_action');
    expect(r?.last_error_code).toBe('kill_switch');
    expect(calls).toEqual([]);
  });

  it('ALLOWED_ACCOUNT_IDS dışındaki hesaba gerçek istek atılmaz', async () => {
    const pub = fakePublisher([async () => ({ kind: 'done', externalId: 'x', url: null })]);
    restore = overridePublisherForTesting('instagram', pub);
    const { post } = await scheduledPost();
    const { env: qenv, sent } = queueEnv({ DRY_RUN: 'false', ALLOWED_ACCOUNT_IDS: 'baska-hesap' });
    await acquireLease(env.DB, post.id, 'o', new Date());
    sent.push({ body: { postId: post.id, traceId: post.trace_id, leaseOwner: 'o' }, delay: 0 });
    await drain(qenv, sent, new Date());
    expect((await row(post.id))?.last_error_code).toBe('account_not_allowed');
    expect(pub.calls).toEqual([]);
  });
});
