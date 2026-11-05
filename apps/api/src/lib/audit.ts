import { newId, nowIso, run } from './db';
import { mask } from './log';

/** Audit kaydı — detail maskelenir; sır içermez. */
export async function audit(
  db: D1Database,
  actor: string,
  action: string,
  entityType: string | null,
  entityId: string | null,
  detail?: Record<string, unknown>,
): Promise<void> {
  await run(
    db,
    'INSERT INTO audit_log (id, at, actor_email, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
    newId(),
    nowIso(),
    actor,
    action,
    entityType,
    entityId,
    detail ? JSON.stringify(mask(detail)) : null,
  );
}
