/** Analiz hesapları: toplamlar, günlük seri, gün×saat ısı haritası, en iyi saatler. */
import {
  zonedParts,
  ymdInTz,
  type AnalyticsDTO,
  type HeatCell,
  type MetricPoint,
} from '@socialplan/shared';

export const MIN_POSTS_PER_BUCKET = 3;

export interface AnalyticsPoint extends MetricPoint {
  title: string | null;
  url: string | null;
}

export const engagement = (
  p: Pick<MetricPoint, 'likes' | 'comments' | 'shares' | 'saves'>,
): number => p.likes + p.comments + p.shares + p.saves;

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

export function computeAnalytics(
  points: AnalyticsPoint[],
  tz: string,
  minN = MIN_POSTS_PER_BUCKET,
): AnalyticsDTO {
  const totals = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0, posts: points.length };
  const daily = new Map<string, { views: number; engagement: number }>();
  const buckets = new Map<string, number[]>();
  const counts = new Map<string, number>();
  for (const p of points) {
    totals.views += p.views;
    totals.likes += p.likes;
    totals.comments += p.comments;
    totals.shares += p.shares;
    totals.saves += p.saves;
    const day = ymdInTz(p.published_at, tz);
    const d = daily.get(day) ?? { views: 0, engagement: 0 };
    d.views += p.views;
    d.engagement += engagement(p);
    daily.set(day, d);
    const z = zonedParts(p.published_at, tz);
    const key = `${z.weekday}|${z.hour}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    // Oran = (beğeni+yorum+paylaşım+kaydetme) / görüntülenme; görüntülenmesi 0 olan post orana girmez.
    if (p.views > 0) buckets.set(key, [...(buckets.get(key) ?? []), engagement(p) / p.views]);
  }
  const heatmap: HeatCell[] = [];
  for (let wd = 1; wd <= 7; wd++) {
    for (let h = 0; h < 24; h++) {
      const key = `${wd}|${h}`;
      heatmap.push({
        weekday: wd,
        hour: h,
        posts: counts.get(key) ?? 0,
        median_rate: median(buckets.get(key) ?? []),
      });
    }
  }
  const best_hours = heatmap
    .filter((c) => c.posts >= minN && c.median_rate !== null)
    .sort((a, b) => (b.median_rate as number) - (a.median_rate as number))
    .slice(0, 3)
    .map((c) => ({ weekday: c.weekday, hour: c.hour, median_rate: c.median_rate as number }));
  const top_posts = [...points].sort((a, b) => b.views - a.views).slice(0, 5);
  return {
    totals,
    daily: [...daily.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day, ...v })),
    heatmap,
    best_hours,
    top_posts,
    min_posts_per_bucket: minN,
  };
}
