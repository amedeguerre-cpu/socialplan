import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { PostDTO } from '@socialplan/shared';
import { api } from './helpers';
import { createBrand, insertAccount, uploadVideo } from './fixtures';
import { drain, queueEnv } from './queue';
import { fillQueue } from '../src/scheduler/fill';
import { dispatchDue, handleScheduled, reap } from '../src/scheduler/cron';
import { acquireLease } from '../src/lib/posts';
import { createLogger } from '../src/lib/log';
import { setTransportForTesting } from '../src/publish/http';

const MON_MIDNIGHT_IST = new Date('2026-11-08T21:00:00Z'); // Pzt 00:00 İstanbul
const log = createLogger({ test: true });

async function setupBrand(opts: { videos?: number } = {}) {
  const b = await createBrand();
  const ig = await insertAccount(b.id, 'instagram');
  const yt = await insertAccount(b.id, 'youtube');
  const tt = await insertAccount(b.id, 'tiktok');
  for (const s of [
    { weekday: 1, time_local: '09:00', platforms: ['instagram', 'youtube'] },
    { weekday: 3, time_local: '18:30', platforms: ['tiktok'] },
    { weekday: 5, time_local: '12:00', platforms: ['instagram'] },
  ]) {
    const r = await api('/api/slots', { method: 'POST', json: { brand_id: b.id, ...s } });
    expect(r.status).toBe(201);
  }
  const videos = [];
  for (let i = 0; i < (opts.videos ?? 5); i++)
    videos.push(
      await uploadVideo(b.id, {
        name: `v${i}.mp4`,
        hash:
          `${'0'.repeat(14)}${b.id.slice(0, 2)}${i}`.padEnd(16, '0').replace(/[^0-9a-f]/g, 'a') + i,
      }),
    );
  return { brand: b, accounts: { ig, yt, tt }, videos };
}

async function posts(brandId: string): Promise<PostDTO[]> {
  const r = await api(`/api/posts?brand_id=${brandId}&page_size=200`);
  return ((await r.json()) as { items: PostDTO[] }).items;
}

describe('kuyruk doldurma', () => {
  it('slot oluşumlarına FIFO atar, her platform ayrı post, İstanbul→UTC doğru', async () => {
    const { brand, videos } = await setupBrand();
    const r = await fillQueue(env.DB, brand.id, 7, MON_MIDNIGHT_IST);
    expect(r.occurrences).toBe(3);
    expect(r.created).toBe(4);
    const ps = await posts(brand.id);
    expect(ps.map((p) => [p.platform, p.scheduled_at, p.video_id])).toEqual([
      ['instagram', '2026-11-09T06:00:00.000Z', videos[0]?.id],
      ['youtube', '2026-11-09T06:00:00.000Z', videos[0]?.id],
      ['tiktok', '2026-11-11T15:30:00.000Z', videos[1]?.id],
      ['instagram', '2026-11-13T09:00:00.000Z', videos[2]?.id],
    ]);
    expect(ps.every((p) => p.status === 'scheduled' && p.caption_snapshot !== null)).toBe(true);
    // İkinci doldurma aynı oluşumları tekrar doldurmaz
    const r2 = await fillQueue(env.DB, brand.id, 7, MON_MIDNIGHT_IST);
    expect(r2.created).toBe(0);
    // Atanan videolar kuyruktan çıktı
    const v0 = (await (await api(`/api/videos/${videos[0]?.id}`)).json()) as { status: string };
    expect(v0.status).toBe('assigned');
  });

  it('API ile doldurma ve kuyruk bitince durma', async () => {
    const { brand } = await setupBrand({ videos: 1 });
    const r = await fillQueue(env.DB, brand.id, 14, MON_MIDNIGHT_IST);
    expect(r.videos_used).toBe(1);
    expect(r.created).toBe(2);
  });
});

describe('elle tarih-saat', () => {
  it('İstanbul saatiyle planlar; aynı video aynı hesaba ikinci kez planlanamaz', async () => {
    const b = await createBrand();
    await insertAccount(b.id, 'instagram');
    await insertAccount(b.id, 'youtube');
    const v = await uploadVideo(b.id);
    const r = await api('/api/posts/manual', {
      method: 'POST',
      json: {
        video_id: v.id,
        platforms: ['instagram', 'youtube'],
        date: '2030-01-15',
        time: '20:45',
      },
    });
    expect(r.status).toBe(201);
    const created = (await r.json()) as PostDTO[];
    expect(created.map((p) => p.scheduled_at)).toEqual([
      '2030-01-15T17:45:00.000Z',
      '2030-01-15T17:45:00.000Z',
    ]);
    const dup = await api('/api/posts/manual', {
      method: 'POST',
      json: { video_id: v.id, platforms: ['instagram'], date: '2030-01-16', time: '10:00' },
    });
    expect(dup.status).toBe(409);
    const past = await api('/api/posts/manual', {
      method: 'POST',
      json: { video_id: v.id, platforms: ['youtube'], date: '2020-01-01', time: '10:00' },
    });
    expect(past.status).toBe(400);
  });

  it('bağlı olmayan platform reddedilir', async () => {
    const b = await createBrand();
    const v = await uploadVideo(b.id);
    const r = await api('/api/posts/manual', {
      method: 'POST',
      json: { video_id: v.id, platforms: ['tiktok'], date: '2030-01-15', time: '20:45' },
    });
    expect(r.status).toBe(400);
  });
});

describe('cron ve DryRun hattı', () => {
  it('zamanı gelen post’lar dry-run ile yayınlanır; TikTok taslağa gider; dış istek yok', async () => {
    const calls: string[] = [];
    setTransportForTesting(async (req) => {
      calls.push(req.url);
      return new Response('{}');
    });
    const { brand, videos } = await setupBrand();
    await fillQueue(env.DB, brand.id, 7, MON_MIDNIGHT_IST);
    const { env: qenv, sent } = queueEnv();
    const at = new Date('2026-11-09T06:00:30Z');
    await handleScheduled(qenv, at, '* * * * *');
    const ids = new Set((await posts(brand.id)).map((p) => p.id));
    expect(sent.filter((m) => ids.has(m.body.postId))).toHaveLength(2);
    await drain(qenv, sent, at);
    let ps = await posts(brand.id);
    expect(
      ps
        .filter((p) => p.status === 'published')
        .map((p) => p.platform)
        .sort(),
    ).toEqual(['instagram', 'youtube']);
    expect(ps.find((p) => p.platform === 'instagram')?.visibility).toBe('dry-run');
    expect(ps.find((p) => p.platform === 'instagram')?.external_url).toMatch(
      /^https:\/\/dry-run\.invalid\//,
    );
    // TikTok: Çarşamba
    const wed = new Date('2026-11-11T15:30:10Z');
    await handleScheduled(qenv, wed, '* * * * *');
    await drain(qenv, sent, wed);
    ps = await posts(brand.id);
    expect(ps.find((p) => p.platform === 'tiktok')?.status).toBe('inbox_sent');
    const v0 = (await (await api(`/api/videos/${videos[0]?.id}`)).json()) as { status: string };
    expect(v0.status).toBe('published');
    // Olay geçmişi
    const ev = (await (await api(`/api/posts/${ps[0]?.id}/events`)).json()) as {
      to_status: string;
      step: string;
    }[];
    expect(ev.map((e) => e.step)).toEqual(
      expect.arrayContaining(['upload', 'processing', 'commit', 'done']),
    );
    expect(calls.filter((u) => !u.includes('slack') && !u.includes('telegram'))).toEqual([]);
  });

  it('duraklatılmış marka ve kill switch atlanır', async () => {
    const { brand } = await setupBrand({ videos: 1 });
    await fillQueue(env.DB, brand.id, 7, MON_MIDNIGHT_IST);
    const at = new Date('2026-11-09T06:00:30Z');
    await api(`/api/brands/${brand.id}`, { method: 'PATCH', json: { paused: true } });
    const { env: qenv, sent } = queueEnv();
    const ids = new Set((await posts(brand.id)).map((p) => p.id));
    const mine = () => sent.filter((m) => ids.has(m.body.postId));
    await handleScheduled(qenv, at, '* * * * *');
    expect(mine()).toHaveLength(0);
    await api(`/api/brands/${brand.id}`, { method: 'PATCH', json: { paused: false } });
    await api('/api/settings', { method: 'PUT', json: { kill_switch: true } });
    await handleScheduled(qenv, at, '* * * * *');
    expect(mine()).toHaveLength(0);
    await api('/api/settings', { method: 'PUT', json: { kill_switch: false } });
    await handleScheduled(qenv, at, '* * * * *');
    expect(mine()).toHaveLength(2);
  });

  it('tolerans aşılırsa kaçırılan slot: işlem gerekli, otomatik yayın yok', async () => {
    const { brand } = await setupBrand({ videos: 1 });
    await fillQueue(env.DB, brand.id, 7, MON_MIDNIGHT_IST);
    const { env: qenv, sent } = queueEnv();
    const late = new Date('2026-11-09T06:45:00Z'); // 45 dk geç (tolerans 30)
    await dispatchDue(qenv, late, 30, log);
    const ids = new Set((await posts(brand.id)).map((p) => p.id));
    expect(sent.filter((m) => ids.has(m.body.postId))).toHaveLength(0);
    const ps = await posts(brand.id);
    expect(
      ps
        .filter((p) => p.status === 'needs_action')
        .every((p) => p.last_error_code === 'missed_slot'),
    ).toBe(true);
    expect(ps.filter((p) => p.status === 'needs_action')).toHaveLength(2);
    // İnsan tekrar dener → hemen kuyruğa
    const { env: qenv2 } = queueEnv();
    void qenv2;
    const r = await api(`/api/posts/${ps[0]?.id}/retry`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as PostDTO).status).toBe('processing');
  });
});

describe('iki kez yayın olmaz', () => {
  it('eşzamanlı iki kilitten yalnız biri kazanır; aynı sahip yeniden alabilir; süresi dolan devralınır', async () => {
    const { brand } = await setupBrand({ videos: 1 });
    await fillQueue(env.DB, brand.id, 7, MON_MIDNIGHT_IST);
    const [p] = await posts(brand.id);
    const at = new Date('2026-11-09T06:00:05Z');
    const results = await Promise.all([
      acquireLease(env.DB, p!.id, 'A', at),
      acquireLease(env.DB, p!.id, 'B', at),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results[0] ? 'A' : 'B';
    const loser = winner === 'A' ? 'B' : 'A';
    expect(await acquireLease(env.DB, p!.id, winner, at)).toBe(true);
    expect(await acquireLease(env.DB, p!.id, loser, at)).toBe(false);
    // 16 dk sonra lease düşer → devralınır
    const later = new Date(at.getTime() + 16 * 60_000);
    expect(await acquireLease(env.DB, p!.id, loser, later)).toBe(true);
    expect(await acquireLease(env.DB, p!.id, winner, later)).toBe(false);
  });

  it('henüz zamanı gelmemiş post kilitlenemez', async () => {
    const { brand } = await setupBrand({ videos: 1 });
    await fillQueue(env.DB, brand.id, 7, MON_MIDNIGHT_IST);
    const [p] = await posts(brand.id);
    expect(await acquireLease(env.DB, p!.id, 'A', MON_MIDNIGHT_IST)).toBe(false);
  });

  it('reaper lease’i dolmuş post’u yeniden kuyruğa alır', async () => {
    const { brand } = await setupBrand({ videos: 1 });
    await fillQueue(env.DB, brand.id, 7, MON_MIDNIGHT_IST);
    const [p] = await posts(brand.id);
    const at = new Date('2026-11-09T06:00:05Z');
    await acquireLease(env.DB, p!.id, 'kayip-mesaj', at);
    const { env: qenv, sent } = queueEnv();
    await reap(qenv, new Date(at.getTime() + 5 * 60_000), log);
    expect(sent.filter((m) => m.body.postId === p!.id)).toHaveLength(0);
    await reap(qenv, new Date(at.getTime() + 16 * 60_000), log);
    const mine = sent.filter((m) => m.body.postId === p!.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.body.leaseOwner).toMatch(/^reaper:/);
  });
});

describe('panel işlemleri', () => {
  it('şimdi paylaş, iptal, toplu iptal, Yayınladım', async () => {
    const b = await createBrand();
    await insertAccount(b.id, 'instagram');
    await insertAccount(b.id, 'tiktok');
    const v1 = await uploadVideo(b.id, { hash: 'aaaaaaaaaaaaaaa1' });
    const v2 = await uploadVideo(b.id, { hash: 'aaaaaaaaaaaaaaa2' });
    const [p1] = (await (
      await api('/api/posts/manual', {
        method: 'POST',
        json: { video_id: v1.id, platforms: ['instagram'], date: '2030-01-01', time: '10:00' },
      })
    ).json()) as PostDTO[];
    const now = await api(`/api/posts/${p1!.id}/publish-now`, { method: 'POST' });
    expect(((await now.json()) as PostDTO).status).toBe('processing');
    // işleniyor → iptal edilebilir (insan)
    const can = await api(`/api/posts/${p1!.id}/cancel`, { method: 'POST' });
    expect(((await can.json()) as PostDTO).status).toBe('cancelled');
    const v1after = (await (await api(`/api/videos/${v1.id}`)).json()) as { status: string };
    expect(v1after.status).toBe('ready');
    // TikTok inbox → Yayınladım
    const [p2] = (await (
      await api('/api/posts/manual', {
        method: 'POST',
        json: { video_id: v2.id, platforms: ['tiktok'], date: '2030-01-01', time: '10:00' },
      })
    ).json()) as PostDTO[];
    await env.DB.prepare("UPDATE posts SET status = 'inbox_sent' WHERE id = ?").bind(p2!.id).run();
    const bad = await api(`/api/posts/${p2!.id}/mark-published`, {
      method: 'POST',
      json: { url: 'https://kotu.example/x' },
    });
    expect(bad.status).toBe(400);
    const ok = await api(`/api/posts/${p2!.id}/mark-published`, {
      method: 'POST',
      json: { url: 'https://www.tiktok.com/@marka/video/7300000000000000001' },
    });
    const okj = (await ok.json()) as PostDTO;
    expect(okj.status).toBe('published');
    expect(okj.external_url).toContain('7300000000000000001');
    // yayınlanmış post iptal edilemez
    expect((await api(`/api/posts/${p2!.id}/cancel`, { method: 'POST' })).status).toBe(409);
    const bulk = await api('/api/posts/bulk', {
      method: 'POST',
      json: { ids: [p2!.id], action: 'cancel' },
    });
    expect(((await bulk.json()) as { results: { ok: boolean }[] }).results[0]?.ok).toBe(false);
  });
});
