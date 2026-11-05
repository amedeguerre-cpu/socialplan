import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AnalyticsDTO } from '@socialplan/shared';
import { api, testEnv } from './helpers';
import { createBrand, insertAccount, uploadVideo } from './fixtures';
import { json, mockServer } from './mockServer';
import { computeAnalytics, median } from '../src/lib/analytics';
import { fetchAllMetrics } from '../src/scheduler/metrics';
import { createLogger } from '../src/lib/log';

const pt = (at: string, views: number, likes: number) => ({
  post_id: at,
  platform: 'instagram' as const,
  brand_id: 'b',
  published_at: at,
  views,
  likes,
  comments: 0,
  shares: 0,
  saves: 0,
  title: null,
  url: null,
});

describe('analiz hesapları', () => {
  it('ortanca ve en iyi saatler (kovada min N post)', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    const points = [
      // Pzt 21:00 İstanbul (18:00Z): oran 0.10 ×3
      pt('2026-11-02T18:00:00Z', 100, 10),
      pt('2026-11-09T18:05:00Z', 200, 20),
      pt('2026-11-16T18:10:00Z', 100, 10),
      // Sal 09:00 (06:00Z): oran 0.02 ×3
      pt('2026-11-03T06:00:00Z', 100, 2),
      pt('2026-11-10T06:00:00Z', 100, 2),
      pt('2026-11-17T06:00:00Z', 100, 2),
      // Çar 12:00: oran 0.5 ama yalnız 1 post → en iyi saatlere girmez
      pt('2026-11-04T09:00:00Z', 100, 50),
    ];
    const a = computeAnalytics(points, 'Europe/Istanbul', 3);
    expect(a.best_hours.map((b) => [b.weekday, b.hour])).toEqual([
      [1, 21],
      [2, 9],
    ]);
    expect(a.heatmap.find((c) => c.weekday === 3 && c.hour === 12)?.posts).toBe(1);
    expect(a.totals.views).toBe(800);
    expect(a.daily[0]).toEqual({ day: '2026-11-02', views: 100, engagement: 10 });
  });
});

describe('metrik cron’u', () => {
  it('yayınlanmış IG/YT/TikTok post’ları için metrik satırı yazar', async () => {
    const b = await createBrand();
    const ig = await insertAccount(b.id, 'instagram');
    const yt = await insertAccount(b.id, 'youtube');
    const tt = await insertAccount(b.id, 'tiktok');
    const v = await uploadVideo(b.id);
    const now = new Date().toISOString();
    const ins = (id: string, acc: string, platform: string, ext: string, state = '{}') =>
      env.DB.prepare(
        "INSERT INTO posts (id, trace_id, video_id, account_id, brand_id, platform, scheduled_at, status, external_id, platform_state, published_at, visibility, created_at, updated_at) VALUES (?, 't', ?, ?, ?, ?, ?, 'published', ?, ?, ?, 'public', ?, ?)",
      )
        .bind(id, v.id, acc, b.id, platform, now, ext, state, now, now, now)
        .run();
    const ids = { ig: crypto.randomUUID(), yt: crypto.randomUUID(), tt: crypto.randomUUID() };
    await ins(ids.ig, ig, 'instagram', 'IGM1');
    await ins(ids.yt, yt, 'youtube', 'YTV1');
    await ins(ids.tt, tt, 'tiktok', 'pub_1', JSON.stringify({ post_id: 'TTV1' }));
    mockServer({
      'GET graph\\.instagram\\.com/v26\\.0/IGM1/insights': (c) => {
        expect(c.url.searchParams.get('metric')).toBe(
          'views,reach,likes,comments,shares,saved,total_interactions',
        );
        return json({
          data: [
            { name: 'views', values: [{ value: 1000 }] },
            { name: 'likes', values: [{ value: 50 }] },
            { name: 'saved', values: [{ value: 7 }] },
          ],
        });
      },
      'GET www\\.googleapis\\.com/youtube/v3/videos': () =>
        json({
          items: [
            { id: 'YTV1', statistics: { viewCount: '400', likeCount: '20', commentCount: '3' } },
          ],
        }),
      'POST open\\.tiktokapis\\.com/v2/video/query/': (c) => {
        expect(JSON.parse(c.body).filters.video_ids).toEqual(['TTV1']);
        return json({
          data: {
            videos: [
              { id: 'TTV1', view_count: 900, like_count: 90, comment_count: 9, share_count: 4 },
            ],
          },
          error: { code: 'ok' },
        });
      },
    });
    await fetchAllMetrics(testEnv({ DRY_RUN: 'false' }), new Date(), createLogger());
    const m = await env.DB.prepare(
      'SELECT post_id, views, likes, saves, shares FROM metrics WHERE post_id IN (?, ?, ?)',
    )
      .bind(ids.ig, ids.yt, ids.tt)
      .all<{ post_id: string; views: number; likes: number; saves: number; shares: number }>();
    const by = Object.fromEntries(m.results.map((r) => [r.post_id, r]));
    expect(by[ids.ig]).toMatchObject({ views: 1000, likes: 50, saves: 7 });
    expect(by[ids.yt]).toMatchObject({ views: 400, likes: 20 });
    expect(by[ids.tt]).toMatchObject({ views: 900, shares: 4 });
  });

  it('demo metrikleri analiz ucunda ısı haritası ve en iyi saatlerle görünür', async () => {
    const b = await createBrand();
    await insertAccount(b.id, 'instagram');
    const r = await api('/api/analytics/demo', {
      method: 'POST',
      json: { brand_id: b.id, posts: 150 },
    });
    expect(r.status).toBe(200);
    const a = (await (await api(`/api/analytics?brand_id=${b.id}&days=90`)).json()) as AnalyticsDTO;
    expect(a.totals.posts).toBe(150);
    expect(a.heatmap).toHaveLength(168);
    expect(a.best_hours.length).toBeGreaterThan(0);
    expect(a.best_hours[0]?.hour).toBeGreaterThanOrEqual(19);
    // demo post'lar video listesinde görünmez
    const vids = (await (await api(`/api/videos?brand_id=${b.id}`)).json()) as unknown[];
    expect(vids).toHaveLength(0);
  });
});
