/** Haftalık özet: son 7 gün performansı, önceki haftayla kıyas, en iyi 3 video, gelecek haftanın doluluğu. */
import {
  addDaysYmd,
  PLATFORM_LABELS,
  weekdayOfYmd,
  ymdInTz,
  zonedToUtc,
  type Platform,
  type WeeklyReportDTO,
} from '@socialplan/shared';
import { all, first } from './db';
import type { BrandRow } from './rows';
import { brandStats } from '../routes/brands';

interface Pt {
  platform: Platform;
  title: string | null;
  url: string | null;
  views: number;
  eng: number;
}

async function points(db: D1Database, brandId: string, from: string, to: string): Promise<Pt[]> {
  return all<Pt>(
    db,
    `SELECT p.platform, v.title, p.external_url AS url, m.views, (m.likes + m.comments + m.shares + m.saves) AS eng
     FROM posts p JOIN videos v ON v.id = p.video_id
     JOIN metrics m ON m.id = (SELECT id FROM metrics WHERE post_id = p.id ORDER BY fetched_at DESC LIMIT 1)
     WHERE p.brand_id = ? AND p.status = 'published' AND p.published_at >= ? AND p.published_at < ?`,
    brandId,
    from,
    to,
  );
}

const sum = (xs: Pt[], k: 'views' | 'eng'): number => xs.reduce((a, x) => a + x[k], 0);
export const pctChange = (cur: number, prev: number): number | null =>
  prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null;

const nf = new Intl.NumberFormat('tr-TR');
const fmtPct = (p: number | null): string =>
  p === null ? '' : ` (${p >= 0 ? '+' : ''}${String(p).replace('.', ',')}%)`;

export async function buildWeeklyReport(
  db: D1Database,
  brand: BrandRow,
  now: Date,
  appBaseUrl: string,
): Promise<WeeklyReportDTO> {
  const tz = brand.timezone;
  const today = ymdInTz(now, tz);
  const start = zonedToUtc(addDaysYmd(today, -7), '00:00', tz).toISOString();
  const end = zonedToUtc(today, '00:00', tz).toISOString();
  const prevStart = zonedToUtc(addDaysYmd(today, -14), '00:00', tz).toISOString();
  const nextEnd = zonedToUtc(addDaysYmd(today, 7), '00:00', tz).toISOString();
  const [cur, prev, scheduled, slots, needsAction, failed, stats] = await Promise.all([
    points(db, brand.id, start, end),
    points(db, brand.id, prevStart, start),
    first<{ n: number }>(
      db,
      "SELECT COUNT(DISTINCT scheduled_at || video_id) AS n FROM posts WHERE brand_id = ? AND status IN ('scheduled','draft') AND scheduled_at >= ? AND scheduled_at < ?",
      brand.id,
      now.toISOString(),
      nextEnd,
    ),
    all<{ weekday: number }>(
      db,
      'SELECT weekday FROM slots WHERE brand_id = ? AND active = 1',
      brand.id,
    ),
    first<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM posts WHERE brand_id = ? AND status = 'needs_action'",
      brand.id,
    ),
    first<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM posts WHERE brand_id = ? AND status = 'failed' AND updated_at >= ?",
      brand.id,
      start,
    ),
    brandStats(db),
  ]);
  // Gelecek 7 günün slot oluşum sayısı
  let slotCount = 0;
  for (let d = 0; d < 7; d++) {
    const wd = weekdayOfYmd(addDaysYmd(today, d));
    slotCount += slots.filter((s) => s.weekday === wd).length;
  }
  const views = sum(cur, 'views');
  const engagement = sum(cur, 'eng');
  const top = [...cur]
    .sort((a, b) => b.views - a.views)
    .slice(0, 3)
    .map((p) => ({ title: p.title, platform: p.platform, views: p.views, url: p.url }));
  const sched = scheduled?.n ?? 0;
  const st = stats.get(brand.id);
  const r: Omit<WeeklyReportDTO, 'text'> = {
    brand_id: brand.id,
    brand_name: brand.name,
    period: { from: start, to: end },
    posts: cur.length,
    views,
    engagement,
    views_change: pctChange(views, sum(prev, 'views')),
    engagement_change: pctChange(engagement, sum(prev, 'eng')),
    top,
    next_week: {
      scheduled: sched,
      slots: slotCount,
      fill_rate: slotCount ? Math.min(100, Math.round((sched / slotCount) * 100)) : null,
    },
    queue: { count: st?.queue_count ?? 0, days_left: st?.queue_days_left ?? null },
    needs_action: needsAction?.n ?? 0,
    failed: failed?.n ?? 0,
  };
  const lines = [
    `Son 7 gün: ${r.posts} paylaşım · ${nf.format(views)} görüntülenme${fmtPct(r.views_change)} · ${nf.format(engagement)} etkileşim${fmtPct(r.engagement_change)}`,
  ];
  if (top.length) {
    lines.push('En iyi videolar:');
    top.forEach((t, i) =>
      lines.push(
        `${i + 1}. ${t.title ?? '—'} (${PLATFORM_LABELS[t.platform]}) — ${nf.format(t.views)}${t.url ? ` ${t.url}` : ''}`,
      ),
    );
  }
  lines.push(
    `Gelecek 7 gün: ${sched} planlı paylaşım / ${slotCount} slot${r.next_week.fill_rate !== null ? ` (%${r.next_week.fill_rate} dolu)` : ''}`,
    `Kuyruk: ${r.queue.count} video${r.queue.days_left !== null ? ` (≈ ${String(r.queue.days_left).replace('.', ',')} gün)` : ''}`,
  );
  if (r.needs_action || r.failed)
    lines.push(`Dikkat: ${r.needs_action} işlem gerekli, ${r.failed} hata (son 7 gün)`);
  lines.push(`${appBaseUrl}/analiz`);
  return { ...r, text: lines.join('\n') };
}
