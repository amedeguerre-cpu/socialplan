import { Hono } from 'hono';
import {
  brandCreateSchema,
  brandUpdateSchema,
  type BrandDTO,
  type Platform,
} from '@socialplan/shared';
import { all, b2i, first, newId, nowIso, run } from '../lib/db';
import { toBrandDTO } from '../lib/dto';
import { conflict, notFound } from '../lib/errors';
import { audit } from '../lib/audit';
import { avatarKey, presignPut } from '../lib/r2';
import { v } from '../lib/validate';
import type { BrandRow } from '../lib/rows';
import type { AppEnv } from '../types';

function slugify(name: string): string {
  const map: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', İ: 'i' };
  return (
    name
      .toLowerCase()
      .replace(/[çğıöşüİ]/g, (ch) => map[ch] ?? ch)
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'marka'
  );
}

export async function brandStats(
  db: D1Database,
): Promise<Map<string, Pick<BrandDTO, 'queue_count' | 'queue_days_left' | 'platforms'>>> {
  const [queue, slots, accounts] = await Promise.all([
    all<{ brand_id: string; n: number }>(
      db,
      "SELECT brand_id, COUNT(*) AS n FROM videos WHERE status = 'ready' AND deleted_at IS NULL GROUP BY brand_id",
    ),
    all<{ brand_id: string; n: number }>(
      db,
      'SELECT brand_id, COUNT(*) AS n FROM slots WHERE active = 1 GROUP BY brand_id',
    ),
    all<{ brand_id: string; platform: Platform }>(
      db,
      "SELECT brand_id, platform FROM accounts WHERE status <> 'disabled'",
    ),
  ]);
  const out = new Map<string, Pick<BrandDTO, 'queue_count' | 'queue_days_left' | 'platforms'>>();
  const get = (id: string) => {
    let s = out.get(id);
    if (!s) {
      s = { queue_count: 0, queue_days_left: null, platforms: [] };
      out.set(id, s);
    }
    return s;
  };
  for (const q of queue) get(q.brand_id).queue_count = q.n;
  for (const a of accounts) get(a.brand_id).platforms.push(a.platform);
  // kalan gün = kuyruktaki video / günlük slot (haftalık aktif slot / 7)
  for (const s of slots) {
    const st = get(s.brand_id);
    st.queue_days_left = Math.floor((st.queue_count / (s.n / 7)) * 10) / 10;
  }
  return out;
}

const empty = { queue_count: 0, queue_days_left: null, platforms: [] as Platform[] };

export const brandRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const rows = await all<BrandRow>(c.env.DB, 'SELECT * FROM brands ORDER BY name');
    const stats = await brandStats(c.env.DB);
    return c.json<BrandDTO[]>(rows.map((r) => toBrandDTO(r, stats.get(r.id) ?? empty)));
  })
  .get('/:id', async (c) => {
    const r = await first<BrandRow>(
      c.env.DB,
      'SELECT * FROM brands WHERE id = ?',
      c.req.param('id'),
    );
    if (!r) throw notFound('Marka');
    const stats = await brandStats(c.env.DB);
    return c.json<BrandDTO>(toBrandDTO(r, stats.get(r.id) ?? empty));
  })
  .post('/', v('json', brandCreateSchema), async (c) => {
    const body = c.req.valid('json');
    const id = newId();
    const at = nowIso();
    const slug = body.slug ?? slugify(body.name);
    const exists = await first(c.env.DB, 'SELECT id FROM brands WHERE slug = ?', slug);
    if (exists) throw conflict(`"${slug}" kısa adı kullanımda`, 'slug_taken');
    await run(
      c.env.DB,
      'INSERT INTO brands (id, name, slug, color, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      body.name,
      slug,
      body.color ?? '#6366f1',
      body.timezone ?? 'Europe/Istanbul',
      at,
      at,
    );
    await audit(c.env.DB, c.get('actor'), 'brand.create', 'brand', id, { name: body.name });
    const r = await first<BrandRow>(c.env.DB, 'SELECT * FROM brands WHERE id = ?', id);
    return c.json<BrandDTO>(toBrandDTO(r as BrandRow, empty), 201);
  })
  .patch('/:id', v('json', brandUpdateSchema), async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const cur = await first<BrandRow>(c.env.DB, 'SELECT * FROM brands WHERE id = ?', id);
    if (!cur) throw notFound('Marka');
    if (body.timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: body.timezone });
      } catch {
        throw conflict('Geçersiz saat dilimi', 'bad_timezone');
      }
    }
    await run(
      c.env.DB,
      `UPDATE brands SET name = ?, color = ?, timezone = ?, paused = ?, autofill_enabled = ?, autofill_days = ?, avatar_key = ?, caption_signature = ?, updated_at = ? WHERE id = ?`,
      body.name ?? cur.name,
      body.color ?? cur.color,
      body.timezone ?? cur.timezone,
      body.paused === undefined ? cur.paused : b2i(body.paused),
      body.autofill_enabled === undefined ? cur.autofill_enabled : b2i(body.autofill_enabled),
      body.autofill_days ?? cur.autofill_days,
      body.avatar_key === undefined ? cur.avatar_key : body.avatar_key,
      body.caption_signature ?? cur.caption_signature ?? '',
      nowIso(),
      id,
    );
    await audit(
      c.env.DB,
      c.get('actor'),
      body.paused !== undefined ? (body.paused ? 'brand.pause' : 'brand.resume') : 'brand.update',
      'brand',
      id,
      body,
    );
    const r = await first<BrandRow>(c.env.DB, 'SELECT * FROM brands WHERE id = ?', id);
    const stats = await brandStats(c.env.DB);
    return c.json<BrandDTO>(toBrandDTO(r as BrandRow, stats.get(id) ?? empty));
  })
  .post('/:id/avatar', async (c) => {
    const id = c.req.param('id');
    const cur = await first<BrandRow>(c.env.DB, 'SELECT id FROM brands WHERE id = ?', id);
    if (!cur) throw notFound('Marka');
    const key = avatarKey(id);
    const url = await presignPut(c.env, key);
    await run(
      c.env.DB,
      'UPDATE brands SET avatar_key = ?, updated_at = ? WHERE id = ?',
      key,
      nowIso(),
      id,
    );
    return c.json({ url, key });
  });
