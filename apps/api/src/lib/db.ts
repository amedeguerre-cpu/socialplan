/** Ham SQL için ince tipli yardımcılar (ORM yok). */

export const newId = (): string => crypto.randomUUID();
export const nowIso = (d: Date = new Date()): string => d.toISOString();

export type SqlValue = string | number | null;

export async function all<T>(db: D1Database, sql: string, ...params: SqlValue[]): Promise<T[]> {
  const r = await db
    .prepare(sql)
    .bind(...params)
    .all<T>();
  return r.results;
}

export async function first<T>(
  db: D1Database,
  sql: string,
  ...params: SqlValue[]
): Promise<T | null> {
  return (
    (await db
      .prepare(sql)
      .bind(...params)
      .first<T>()) ?? null
  );
}

export async function run(db: D1Database, sql: string, ...params: SqlValue[]): Promise<number> {
  const r = await db
    .prepare(sql)
    .bind(...params)
    .run();
  return r.meta.changes;
}

export const bool = (v: unknown): boolean => v === 1 || v === true || v === '1';
export const b2i = (v: boolean | undefined | null): number => (v ? 1 : 0);

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (s === null || s === undefined || s === '') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** D1 bağlı parametre sınırı (100) için parçalara böl. */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
