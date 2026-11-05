import { Hono } from 'hono';
import { slotUpdateSchema, slotUpsertSchema, type SlotDTO } from '@socialplan/shared';
import { all, b2i, first, newId, run } from '../lib/db';
import { toSlotDTO } from '../lib/dto';
import { badRequest, conflict, notFound } from '../lib/errors';
import { audit } from '../lib/audit';
import { v } from '../lib/validate';
import type { SlotRow } from '../lib/rows';
import type { AppEnv } from '../types';

export const slotRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const brandId = c.req.query('brand_id');
    if (!brandId) throw badRequest('brand_id gerekli');
    const rows = await all<SlotRow>(
      c.env.DB,
      'SELECT * FROM slots WHERE brand_id = ? ORDER BY weekday, time_local',
      brandId,
    );
    return c.json<SlotDTO[]>(rows.map(toSlotDTO));
  })
  .post('/', v('json', slotUpsertSchema), async (c) => {
    const b = c.req.valid('json');
    const brand = await first(c.env.DB, 'SELECT id FROM brands WHERE id = ?', b.brand_id);
    if (!brand) throw notFound('Marka');
    const id = newId();
    try {
      await run(
        c.env.DB,
        'INSERT INTO slots (id, brand_id, weekday, time_local, platforms, active) VALUES (?, ?, ?, ?, ?, ?)',
        id,
        b.brand_id,
        b.weekday,
        b.time_local,
        JSON.stringify([...new Set(b.platforms)]),
        b2i(b.active ?? true),
      );
    } catch {
      throw conflict('Bu gün ve saatte slot zaten var', 'slot_exists');
    }
    await audit(c.env.DB, c.get('actor'), 'slot.create', 'slot', id, b);
    return c.json<SlotDTO>(
      toSlotDTO(
        (await first<SlotRow>(c.env.DB, 'SELECT * FROM slots WHERE id = ?', id)) as SlotRow,
      ),
      201,
    );
  })
  .patch('/:id', v('json', slotUpdateSchema), async (c) => {
    const id = c.req.param('id');
    const b = c.req.valid('json');
    const cur = await first<SlotRow>(c.env.DB, 'SELECT * FROM slots WHERE id = ?', id);
    if (!cur) throw notFound('Slot');
    try {
      await run(
        c.env.DB,
        'UPDATE slots SET weekday = ?, time_local = ?, platforms = ?, active = ? WHERE id = ?',
        b.weekday ?? cur.weekday,
        b.time_local ?? cur.time_local,
        b.platforms ? JSON.stringify([...new Set(b.platforms)]) : cur.platforms,
        b.active === undefined ? cur.active : b2i(b.active),
        id,
      );
    } catch {
      throw conflict('Bu gün ve saatte slot zaten var', 'slot_exists');
    }
    await audit(c.env.DB, c.get('actor'), 'slot.update', 'slot', id, b);
    return c.json<SlotDTO>(
      toSlotDTO(
        (await first<SlotRow>(c.env.DB, 'SELECT * FROM slots WHERE id = ?', id)) as SlotRow,
      ),
    );
  })
  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    await run(c.env.DB, 'DELETE FROM slots WHERE id = ?', id);
    await audit(c.env.DB, c.get('actor'), 'slot.delete', 'slot', id);
    return c.json({ ok: true });
  });
