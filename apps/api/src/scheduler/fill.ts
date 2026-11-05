/**
 * Slot tabanlı kuyruk doldurma: önümüzdeki N günün slot oluşumlarına kuyruktaki (FIFO) videoları atar.
 * Bir slot oluşumunda markanın o slottaki her platformu için ayrı post (aynı an). Tek batch(); UNIQUE
 * (video_id, account_id) çift atamayı, INSERT OR IGNORE çakışmayı engeller.
 */
import {
  addDaysYmd,
  buildCaption,
  weekdayOfYmd,
  ymdInTz,
  zonedToUtc,
  type Platform,
  type ValidationResult,
} from '@socialplan/shared';
import { all, first, newId, nowIso, parseJson } from '../lib/db';
import { eventStmt, syncVideoStatusStmt } from '../lib/posts';
import type { AccountRow, BrandRow, SlotRow, VideoRow } from '../lib/rows';

export interface PlannedPost {
  id: string;
  trace_id: string;
  video_id: string;
  account_id: string;
  platform: Platform;
  slot_id: string | null;
  scheduled_at: string;
  caption: string;
}

export interface FillResult {
  created: number;
  occurrences: number;
  videos_used: number;
  posts: PlannedPost[];
}

/** Aynı içerik (content_hash) bu hesaba daha önce planlanmış/paylaşılmış mı? */
export async function hashUsedOnAccount(
  db: D1Database,
  hash: string | null,
  accountId: string,
): Promise<boolean> {
  if (!hash) return false;
  const r = await first(
    db,
    "SELECT p.id FROM posts p JOIN videos v ON v.id = p.video_id WHERE v.content_hash = ? AND p.account_id = ? AND p.status <> 'cancelled' LIMIT 1",
    hash,
    accountId,
  );
  return !!r;
}

export function captionFor(v: VideoRow, platform: Platform, signature = ''): string {
  return buildCaption(
    {
      title: v.title,
      description: v.description,
      hashtags: parseJson(v.hashtags, []),
      caption_overrides: parseJson(v.caption_overrides, {}),
    },
    platform,
    { signature },
  );
}

export function insertPostStmt(
  db: D1Database,
  brandId: string,
  p: PlannedPost,
  status: 'scheduled' | 'draft',
  now: Date,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO posts (id, trace_id, video_id, account_id, brand_id, platform, slot_id, scheduled_at, status, caption_snapshot, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      p.id,
      p.trace_id,
      p.video_id,
      p.account_id,
      brandId,
      p.platform,
      p.slot_id,
      p.scheduled_at,
      status,
      p.caption,
      nowIso(now),
      nowIso(now),
    );
}

export async function fillQueue(
  db: D1Database,
  brandId: string,
  days: number,
  now: Date,
): Promise<FillResult> {
  const brand = await first<BrandRow>(db, 'SELECT * FROM brands WHERE id = ?', brandId);
  if (!brand) throw new Error('Marka bulunamadı');
  const tz = brand.timezone;
  const [slots, accounts, videos, taken] = await Promise.all([
    all<SlotRow>(db, 'SELECT * FROM slots WHERE brand_id = ? AND active = 1', brandId),
    all<AccountRow>(db, "SELECT * FROM accounts WHERE brand_id = ? AND status = 'active'", brandId),
    all<VideoRow>(
      db,
      `SELECT * FROM videos v WHERE v.brand_id = ? AND v.status = 'ready' AND v.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.video_id = v.id AND p.status <> 'cancelled')
       ORDER BY v.queue_position ASC, v.created_at ASC`,
      brandId,
    ),
    all<{ slot_id: string; scheduled_at: string }>(
      db,
      "SELECT slot_id, scheduled_at FROM posts WHERE brand_id = ? AND slot_id IS NOT NULL AND status <> 'cancelled' AND scheduled_at >= ?",
      brandId,
      nowIso(now),
    ),
  ]);
  const accByPlatform = new Map(accounts.map((a) => [a.platform, a]));
  const takenSet = new Set(taken.map((t) => `${t.slot_id}|${t.scheduled_at}`));

  // Slot oluşumları (zaman sırasıyla)
  const today = ymdInTz(now, tz);
  const occ: { slot: SlotRow; at: string }[] = [];
  for (let d = 0; d < days; d++) {
    const ymd = addDaysYmd(today, d);
    const wd = weekdayOfYmd(ymd);
    for (const s of slots) {
      if (s.weekday !== wd) continue;
      const at = zonedToUtc(ymd, s.time_local, tz);
      if (at.getTime() <= now.getTime() + 60_000) continue;
      const iso = at.toISOString();
      if (takenSet.has(`${s.id}|${iso}`)) continue;
      occ.push({ slot: s, at: iso });
    }
  }
  occ.sort((a, b) => a.at.localeCompare(b.at));

  const planned: PlannedPost[] = [];
  const usedVideos = new Set<string>();
  let vi = 0;
  for (const o of occ) {
    const slotPlatforms = parseJson<Platform[]>(o.slot.platforms, []).filter((p) =>
      accByPlatform.has(p),
    );
    if (!slotPlatforms.length) continue;
    // Bu slotun en az bir platformuna uygun sıradaki video
    while (vi < videos.length) {
      const v = videos[vi] as VideoRow;
      vi++;
      const val = parseJson<ValidationResult | null>(v.validation, null);
      const targets: { p: Platform; acc: AccountRow }[] = [];
      for (const p of slotPlatforms) {
        const acc = accByPlatform.get(p) as AccountRow;
        if (val && !val[p].ok) continue;
        if (await hashUsedOnAccount(db, v.content_hash, acc.id)) continue;
        targets.push({ p, acc });
      }
      if (!targets.length) continue;
      for (const t of targets) {
        planned.push({
          id: newId(),
          trace_id: newId(),
          video_id: v.id,
          account_id: t.acc.id,
          platform: t.p,
          slot_id: o.slot.id,
          scheduled_at: o.at,
          caption: captionFor(v, t.p, brand.caption_signature),
        });
      }
      usedVideos.add(v.id);
      break;
    }
    if (vi >= videos.length && !planned.some((p) => p.scheduled_at === o.at)) break;
  }

  if (planned.length) {
    const stmts: D1PreparedStatement[] = [];
    for (const p of planned) {
      stmts.push(insertPostStmt(db, brandId, p, 'scheduled', now));
      stmts.push(
        eventStmt(
          db,
          { id: p.id, trace_id: p.trace_id },
          null,
          'scheduled',
          null,
          { source: 'fill', slot_id: p.slot_id },
          now,
        ),
      );
    }
    for (const vid of usedVideos) stmts.push(syncVideoStatusStmt(db, vid, now));
    const res = await db.batch(stmts);
    const created = res
      .filter((_, i) => i % 2 === 0 && i < planned.length * 2)
      .reduce((a, r) => a + (r.meta.changes ?? 0), 0);
    return { created, occurrences: occ.length, videos_used: usedVideos.size, posts: planned };
  }
  return { created: 0, occurrences: occ.length, videos_used: 0, posts: [] };
}
