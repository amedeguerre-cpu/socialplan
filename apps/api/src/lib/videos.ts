import { positionBetween } from '@socialplan/shared';
import { first } from './db';

export async function nextQueuePosition(db: D1Database, brandId: string): Promise<number> {
  const r = await first<{ m: number | null }>(
    db,
    'SELECT MAX(queue_position) AS m FROM videos WHERE brand_id = ? AND deleted_at IS NULL',
    brandId,
  );
  return positionBetween(r?.m ?? null, null);
}

export async function duplicateWarning(
  db: D1Database,
  hash: string | null | undefined,
  brandId: string,
  selfId?: string,
): Promise<string | null> {
  if (!hash) return null;
  const other = await first<{ brand_id: string; name: string; original_name: string }>(
    db,
    `SELECT v.brand_id, b.name, v.original_name FROM videos v JOIN brands b ON b.id = v.brand_id
     WHERE v.content_hash = ? AND v.deleted_at IS NULL AND v.id <> ? ORDER BY v.brand_id = ? DESC LIMIT 1`,
    hash,
    selfId ?? '',
    brandId,
  );
  if (!other) return null;
  return other.brand_id === brandId
    ? `Aynı video bu markada zaten var (${other.original_name})`
    : `Aynı video "${other.name}" markasında da var (${other.original_name})`;
}
