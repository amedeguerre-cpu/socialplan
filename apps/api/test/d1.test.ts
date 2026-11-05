import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/** Faz 0 denemesi: D1 `UPDATE … RETURNING` destekliyor mu? (Sonuç CLAUDE.md'de.) */
describe('D1 davranışı', () => {
  it('UPDATE … RETURNING satır döndürür', async () => {
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('t_ret', '1', 'x')",
    ).run();
    const r = await env.DB.prepare(
      "UPDATE settings SET value = '2' WHERE key = 't_ret' RETURNING key, value",
    ).all<{ key: string; value: string }>();
    expect(r.results).toEqual([{ key: 't_ret', value: '2' }]);
    const none = await env.DB.prepare(
      "UPDATE settings SET value = '3' WHERE key = 'yok' RETURNING key",
    ).all();
    expect(none.results).toEqual([]);
  });

  it('meta.changes koşullu UPDATE sonucunu verir', async () => {
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('t_chg', '1', 'x')",
    ).run();
    const a = await env.DB.prepare(
      "UPDATE settings SET value = '2' WHERE key = 't_chg' AND value = '1'",
    ).run();
    const b = await env.DB.prepare(
      "UPDATE settings SET value = '2' WHERE key = 't_chg' AND value = '1'",
    ).run();
    expect(a.meta.changes).toBe(1);
    expect(b.meta.changes).toBe(0);
  });

  it('batch() atomik: bir ifade düşerse hepsi geri alınır', async () => {
    const ok = env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('t_batch', '1', 'x')",
    );
    const bad = env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('t_batch', '1', 'x')",
    );
    await expect(env.DB.batch([ok, bad])).rejects.toThrow();
    const r = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM settings WHERE key = 't_batch'",
    ).first<{ n: number }>();
    expect(r?.n).toBe(0);
  });

  it('kısmi UNIQUE indeks iptal edilmemiş çift post’u engeller', async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO brands (id, name, slug, created_at, updated_at) VALUES ('b1','B','b1',?,?)",
      ).bind(now, now),
      env.DB.prepare(
        "INSERT INTO accounts (id, brand_id, platform, mode, external_id, created_at, updated_at) VALUES ('a1','b1','instagram','auto','x',?,?)",
      ).bind(now, now),
      env.DB.prepare(
        "INSERT INTO videos (id, brand_id, r2_key, original_name, mime, size_bytes, status, created_at, updated_at) VALUES ('v1','b1','k','a.mp4','video/mp4',1,'ready',?,?)",
      ).bind(now, now),
    ]);
    const ins = (id: string, status: string) =>
      env.DB.prepare(
        "INSERT INTO posts (id, trace_id, video_id, account_id, brand_id, platform, scheduled_at, status, created_at, updated_at) VALUES (?, 't', 'v1', 'a1', 'b1', 'instagram', ?, ?, ?, ?)",
      )
        .bind(id, now, status, now, now)
        .run();
    await ins('p1', 'cancelled');
    await ins('p2', 'scheduled');
    await expect(ins('p3', 'scheduled')).rejects.toThrow(/UNIQUE/);
  });
});
