import { all, nowIso, run } from './db';

export interface Settings {
  kill_switch: boolean;
  youtube_audited: boolean;
  missed_slot_grace_min: number;
  retention_days: number;
  notify: { slack: boolean; telegram: boolean };
  autofill_default_days: number;
}

export const DEFAULT_SETTINGS: Settings = {
  kill_switch: false,
  youtube_audited: false,
  missed_slot_grace_min: 30,
  retention_days: 30,
  notify: { slack: false, telegram: false },
  autofill_default_days: 7,
};

export async function getSettings(db: D1Database): Promise<Settings> {
  const rows = await all<{ key: string; value: string }>(db, 'SELECT key, value FROM settings');
  const s: Settings = structuredClone(DEFAULT_SETTINGS);
  const rec = s as unknown as Record<string, unknown>;
  for (const r of rows) {
    if (!(r.key in s)) continue;
    try {
      rec[r.key] = JSON.parse(r.value);
    } catch {
      /* bozuk değer: varsayılan kalır */
    }
  }
  return s;
}

export async function isKillSwitchOn(db: D1Database): Promise<boolean> {
  const r = await db
    .prepare("SELECT value FROM settings WHERE key = 'kill_switch'")
    .first<{ value: string }>();
  return r?.value === 'true';
}

export async function setSettings(
  db: D1Database,
  patch: Partial<Settings>,
  actor: string,
): Promise<void> {
  const at = nowIso();
  const stmts = Object.entries(patch)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) =>
      db
        .prepare(
          'INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
        )
        .bind(k, JSON.stringify(v), actor, at),
    );
  if (stmts.length) await db.batch(stmts);
}

export async function setRawSetting(
  db: D1Database,
  key: string,
  value: unknown,
  actor: string,
): Promise<void> {
  await run(
    db,
    'INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
    key,
    JSON.stringify(value),
    actor,
    nowIso(),
  );
}
