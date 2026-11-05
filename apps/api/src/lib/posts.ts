/** Post kilidi, olay kaydı ve durum yazımı. Geçişler shared/stateMachine.ts ile denetlenir. */
import { assertTransition, type Actor, type PostStatus } from '@socialplan/shared';
import { newId, nowIso } from './db';
import { mask } from './log';
import type { PostRow } from './rows';

/** Lease payı: Queue tüketicisi/Cron 15 dk duvar saati sınırı. */
export const LEASE_MARGIN_SEC = 15 * 60;

export function leaseUntil(now: Date, waitSec = 0): string {
  return new Date(now.getTime() + (waitSec + LEASE_MARGIN_SEC) * 1000).toISOString();
}

/**
 * Tek koşullu UPDATE ile kilit. Zamanı gelmiş 'scheduled' post'u ya da aynı sahibin / süresi dolmuş
 * lease'li 'processing' post'unu alır. changes = 1 değilse kilit alınamamıştır.
 */
export async function acquireLease(
  db: D1Database,
  postId: string,
  owner: string,
  now: Date,
  waitSec = 0,
): Promise<boolean> {
  const n = nowIso(now);
  const r = await db
    .prepare(
      `UPDATE posts SET status = 'processing', lease_owner = ?, lease_until = ?, updated_at = ?
       WHERE id = ? AND ((status = 'scheduled' AND scheduled_at <= ?) OR (status = 'processing' AND (lease_owner = ? OR lease_until < ?)))`,
    )
    .bind(owner, leaseUntil(now, waitSec), n, postId, n, owner, n)
    .run();
  return r.meta.changes === 1;
}

export function eventStmt(
  db: D1Database,
  post: Pick<PostRow, 'id' | 'trace_id'>,
  from: PostStatus | null,
  to: PostStatus | null,
  step: string | null,
  detail: Record<string, unknown> | null,
  at: Date = new Date(),
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO post_events (id, post_id, trace_id, at, from_status, to_status, step, detail) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM posts WHERE id = ?)',
    )
    .bind(
      newId(),
      post.id,
      post.trace_id,
      nowIso(at),
      from,
      to,
      step,
      detail ? JSON.stringify(mask(detail)) : null,
      post.id,
    );
}

export interface HumanTransition {
  to: PostStatus;
  set?: Record<string, string | number | null>;
  detail?: Record<string, unknown>;
}

/** İnsan geçişi: koşullu UPDATE (durum değişmediyse) + olay. Başarısızsa false. */
export async function humanTransition(
  db: D1Database,
  post: PostRow,
  actor: string,
  t: HumanTransition,
  now = new Date(),
): Promise<boolean> {
  assertTransition(post.status, t.to, 'human' satisfies Actor);
  const set: Record<string, string | number | null> = {
    ...(t.set ?? {}),
    status: t.to,
    updated_at: nowIso(now),
  };
  const cols = Object.keys(set);
  const stmt = db
    .prepare(
      `UPDATE posts SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND status = ?`,
    )
    .bind(...cols.map((c) => set[c] ?? null), post.id, post.status);
  const [r] = await db.batch([
    stmt,
    eventStmt(db, post, post.status, t.to, post.step, { actor, ...(t.detail ?? {}) }, now),
  ]);
  return (r?.meta.changes ?? 0) === 1;
}

/** Videonun durumunu post'larına göre güncelle (kuyruk ↔ atanmış ↔ yayınlanmış). */
export function syncVideoStatusStmt(
  db: D1Database,
  videoId: string,
  now = new Date(),
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE videos SET status = CASE
          WHEN NOT EXISTS (SELECT 1 FROM posts WHERE video_id = ?1 AND status <> 'cancelled') THEN 'ready'
          WHEN NOT EXISTS (SELECT 1 FROM posts WHERE video_id = ?1 AND status NOT IN ('cancelled','published')) THEN 'published'
          ELSE 'assigned' END,
        updated_at = ?2
       WHERE id = ?1 AND deleted_at IS NULL AND status IN ('ready','assigned','published')`,
    )
    .bind(videoId, nowIso(now));
}
