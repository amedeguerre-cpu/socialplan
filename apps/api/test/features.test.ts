/** Yeni özellikler: metin şablonları + marka imzası, haftalık özet, sağlık ekranı, ölü mektup tüketicisi. */
import { createMessageBatch, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { HealthDTO, PostDTO, TemplateDTO, WeeklyReportDTO } from '@socialplan/shared';
import { api, testEnv } from './helpers';
import { createBrand, insertAccount, uploadVideo } from './fixtures';
import { json, mockServer } from './mockServer';
import { claimLease } from '../src/lib/posts';
import { createLogger } from '../src/lib/log';
import { handleScheduled } from '../src/scheduler/cron';
import { handleQueue } from '../src/publish/consumer';
import { computeHealth } from '../src/routes/health';
import { fillQueue } from '../src/scheduler/fill';
import { pctChange } from '../src/lib/weekly';
import { sendWeeklyReports } from '../src/scheduler/weekly';
import { queueEnv } from './queue';

const log = createLogger({ test: 'features' });

describe('metin şablonları ve marka imzası', () => {
  it('CRUD, aynı ad 409, geçersiz tür 400', async () => {
    const b = await createBrand();
    const c = await api('/api/templates', {
      method: 'POST',
      json: {
        brand_id: b.id,
        kind: 'caption',
        name: 'Ürün',
        platform: 'instagram',
        body: '{baslik}\n\n{hashtagler}',
      },
    });
    expect(c.status).toBe(201);
    const t = (await c.json()) as TemplateDTO;
    expect(
      (
        await api('/api/templates', {
          method: 'POST',
          json: { brand_id: b.id, kind: 'caption', name: 'Ürün', body: 'x' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await api('/api/templates', {
          method: 'POST',
          json: { brand_id: b.id, kind: 'emoji', name: 'x', body: 'x' },
        })
      ).status,
    ).toBe(400);
    await api('/api/templates', {
      method: 'POST',
      json: { brand_id: b.id, kind: 'hashtags', name: 'Kahve', body: '#kahve #sabah' },
    });
    const list = (await (await api(`/api/templates?brand_id=${b.id}`)).json()) as TemplateDTO[];
    expect(list.map((x) => `${x.kind}:${x.name}`)).toEqual(['caption:Ürün', 'hashtags:Kahve']);
    const u = (await (
      await api(`/api/templates/${t.id}`, {
        method: 'PATCH',
        json: { body: 'Yeni {baslik}', platform: null },
      })
    ).json()) as TemplateDTO;
    expect(u).toMatchObject({ body: 'Yeni {baslik}', platform: null });
    expect((await api(`/api/templates/${t.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api(`/api/templates/${t.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('marka imzası doldurma ve elle planlamada caption sonuna eklenir', async () => {
    const b = await createBrand();
    await api(`/api/brands/${b.id}`, {
      method: 'PATCH',
      json: { caption_signature: '🛒 kafe.com' },
    });
    await insertAccount(b.id, 'instagram');
    const v = await uploadVideo(b.id);
    await api(`/api/videos/${v.id}`, { method: 'PATCH', json: { description: 'Sabah' } });
    const [p] = (await (
      await api('/api/posts/manual', {
        method: 'POST',
        json: { video_id: v.id, platforms: ['instagram'], date: '2030-01-01', time: '10:00' },
      })
    ).json()) as PostDTO[];
    expect(p?.caption_snapshot).toBe('Sabah\n\n🛒 kafe.com');
    await api('/api/slots', {
      method: 'POST',
      json: { brand_id: b.id, weekday: 1, time_local: '09:00', platforms: ['instagram'] },
    });
    const v2 = await uploadVideo(b.id, { hash: 'bbbbbbbbbbbbbbb2' });
    await fillQueue(env.DB, b.id, 7, new Date('2026-11-08T21:00:00Z'));
    const r = await env.DB.prepare('SELECT caption_snapshot FROM posts WHERE video_id = ?')
      .bind(v2.id)
      .first<{ caption_snapshot: string }>();
    expect(r?.caption_snapshot.endsWith('🛒 kafe.com')).toBe(true);
  });
});

describe('haftalık özet', () => {
  it('son 7 gün, önceki haftayla kıyas, en iyi 3, gelecek hafta doluluğu', async () => {
    const b = await createBrand('Haftalık Marka');
    const acc = await insertAccount(b.id, 'instagram');
    const v = await uploadVideo(b.id);
    const now = new Date();
    const mk = async (daysAgo: number, views: number, title: string) => {
      const vid = crypto.randomUUID();
      const pid = crypto.randomUUID();
      const at = new Date(now.getTime() - daysAgo * 86400_000).toISOString();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO videos (id, brand_id, r2_key, original_name, mime, size_bytes, title, status, created_at, updated_at) VALUES (?, ?, 'k', 'a.mp4', 'video/mp4', 1, ?, 'published', ?, ?)",
        ).bind(vid, b.id, title, at, at),
        env.DB.prepare(
          "INSERT INTO posts (id, trace_id, video_id, account_id, brand_id, platform, scheduled_at, status, external_url, published_at, created_at, updated_at) VALUES (?, 't', ?, ?, ?, 'instagram', ?, 'published', ?, ?, ?, ?)",
        ).bind(pid, vid, acc, b.id, at, `https://ig/${title}`, at, at, at),
        env.DB.prepare(
          'INSERT INTO metrics (id, post_id, fetched_at, views, likes, comments, shares, saves) VALUES (?, ?, ?, ?, ?, 0, 0, 0)',
        ).bind(crypto.randomUUID(), pid, at, views, Math.floor(views / 10)),
      ]);
    };
    await mk(2, 1000, 'A');
    await mk(3, 3000, 'B');
    await mk(4, 500, 'C');
    await mk(5, 200, 'D');
    await mk(10, 2350, 'Eski');
    void v;
    const r = (await (await api(`/api/reports/weekly?brand_id=${b.id}`)).json()) as WeeklyReportDTO;
    expect(r.posts).toBe(4);
    expect(r.views).toBe(4700);
    expect(r.views_change).toBe(100);
    expect(r.top.map((t) => t.title)).toEqual(['B', 'A', 'C']);
    expect(r.text).toContain('En iyi videolar:');
    expect(r.text).toContain('(+100%)');
    expect(pctChange(50, 0)).toBeNull();
  });

  it('Pazartesi 09:05 İstanbul’da cron gönderir; aynı gün ikinci kez göndermez; ayar kapalıysa göndermez', async () => {
    await createBrand('Rapor Markası');
    const m = mockServer({ 'POST hooks\\.slack\\.com/.*': () => json({ ok: true }) });
    await env.DB.prepare(
      'UPDATE settings SET value = \'{"slack":true,"telegram":false}\' WHERE key = \'notify\'',
    ).run();
    const e = queueEnv({ SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/X' }).env;
    try {
      const monday = new Date('2030-01-07T06:05:00Z'); // Pzt 09:05 İstanbul
      await handleScheduled(e, monday, '* * * * *');
      const first = m.calls.filter((c) => c.body.includes('haftalık özet')).length;
      expect(first).toBeGreaterThanOrEqual(1);
      await handleScheduled(e, monday, '* * * * *');
      expect(m.calls.filter((c) => c.body.includes('haftalık özet')).length).toBe(first);
      await api('/api/settings', { method: 'PUT', json: { weekly_report: false } });
      await handleScheduled(e, new Date('2030-01-14T06:05:00Z'), '* * * * *');
      expect(m.calls.filter((c) => c.body.includes('haftalık özet')).length).toBe(first);
      // elle gönderim (force) dedupe'a takılmaz
      expect(await sendWeeklyReports(e, monday, log, { force: true })).toBeGreaterThanOrEqual(1);
    } finally {
      await env.DB.prepare(
        'UPDATE settings SET value = \'{"slack":false,"telegram":false}\' WHERE key = \'notify\'',
      ).run();
      await api('/api/settings', { method: 'PUT', json: { weekly_report: true } });
    }
  });
});

describe('sağlık ekranı ve ölü mektuplar', () => {
  it('cron çalışınca "ok", geciken paylaşım "error", DLQ mesajı post’u işlem gerekli yapar', async () => {
    const now = new Date();
    const { env: qenv } = queueEnv();
    await handleScheduled(qenv, now, '* * * * *');
    let h = await computeHealth(testEnv(), new Date(now.getTime() + 60_000));
    expect(h.checks.find((c) => c.key === 'cron')?.level).toBe('ok');
    h = await computeHealth(testEnv(), new Date(now.getTime() + 10 * 60_000));
    expect(h.checks.find((c) => c.key === 'cron')?.level).toBe('error');
    expect(h.level).toBe('error');

    const b = await createBrand();
    await insertAccount(b.id, 'instagram');
    const v = await uploadVideo(b.id);
    const [p] = (await (
      await api('/api/posts/manual', {
        method: 'POST',
        json: { video_id: v.id, platforms: ['instagram'], date: '2030-01-01', time: '10:00' },
      })
    ).json()) as PostDTO[];
    await env.DB.prepare('UPDATE posts SET scheduled_at = ? WHERE id = ?')
      .bind(new Date(now.getTime() - 10 * 60_000).toISOString(), p!.id)
      .run();
    h = await computeHealth(testEnv(), now);
    expect(h.checks.find((c) => c.key === 'overdue')?.level).toBe('error');

    const seq = (await claimLease(env.DB, p!.id, 'sahip', now)) as number;
    const batch = createMessageBatch('socialplan-publish-dlq', [
      {
        id: 'm1',
        timestamp: now,
        attempts: 6,
        body: { postId: p!.id, traceId: p!.trace_id, leaseOwner: 'sahip', seq },
      },
    ]);
    await handleQueue(batch, testEnv());
    const r = await env.DB.prepare('SELECT status, last_error_code FROM posts WHERE id = ?')
      .bind(p!.id)
      .first<{ status: string; last_error_code: string }>();
    expect(r).toEqual({ status: 'needs_action', last_error_code: 'dlq' });
    h = (await (await api('/api/health')).json()) as HealthDTO;
    expect(h.counts.dlq_24h).toBeGreaterThanOrEqual(1);
    expect(h.checks.find((c) => c.key === 'dlq')?.level).toBe('error');
    // başka sahibin DLQ mesajı yok sayılır
    const other = createMessageBatch('socialplan-publish-dlq', [
      {
        id: 'm2',
        timestamp: now,
        attempts: 6,
        body: { postId: p!.id, traceId: p!.trace_id, leaseOwner: 'baska', seq },
      },
    ]);
    await handleQueue(other, testEnv());
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM post_events WHERE post_id = ? AND step = 'dlq'",
        )
          .bind(p!.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
});
