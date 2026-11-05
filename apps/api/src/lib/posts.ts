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
 * Tek koşullu UPDATE ile kilit (dağıtım: cron, şimdi paylaş, tekrar dene, reaper). Zamanı gelmiş 'scheduled'
 * post'u ya da lease'i dolmuş 'processing' post'u alır ve adım sırasını (msg_seq) artırır.
 * Dönen değer: yeni msg_seq (mesaja yazılır) veya kilit alınamadıysa null.
 */
export async function claimLease(
  db: D1Database,
  postId: string,
  owner: string,
  now: Date,
  waitSec = 0,
): Promise<number | null> {
  const n = nowIso(now);
  const r = await db
    .prepare(
      `UPDATE posts SET status = 'processing', lease_owner = ?, lease_until = ?, msg_seq = msg_seq + 1, updated_at = ?
       WHERE id = ? AND ((status = 'scheduled' AND scheduled_at <= ?) OR (status = 'processing' AND lease_until < ?))
       RETURNING msg_seq`,
    )
    .bind(owner, leaseUntil(now, waitSec), n, postId, n, n)
    .first<{ msg_seq: number }>();
  return r?.msg_seq ?? null;
}

/** Geriye uyumluluk: kilit alındı mı? */
export async function acquireLease(
  db: D1Database,
  postId: string,
  owner: string,
  now: Date,
  waitSec = 0,
): Promise<boolean> {
  return (await claimLease(db, postId, owner, now, waitSec)) !== null;
}

/**
 * Tüketici: yalnız aynı sahip VE beklenen adım sırası (msg_seq) eşleşirse devam eder. Queue en-az-bir-kez
 * teslim eder; aynı mesajın ikinci kopyası sıra artmış olduğundan düşer (adım iki kez çalışmaz).
 */
export async function continueLease(
  db: D1Database,
  postId: string,
  owner: string,
  seq: number,
  now: Date,
): Promise<number | null> {
  const r = await db
    .prepare(
      `UPDATE posts SET lease_until = ?, msg_seq = msg_seq + 1, updated_at = ?
       WHERE id = ? AND status = 'processing' AND lease_owner = ? AND msg_seq = ? RETURNING msg_seq`,
    )
    .bind(leaseUntil(now), nowIso(now), postId, owner, seq)
    .first<{ msg_seq: number }>();
  return r?.msg_seq ?? null;
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
