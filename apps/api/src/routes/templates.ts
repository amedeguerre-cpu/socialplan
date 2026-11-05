import { Hono } from 'hono';
import { templateCreateSchema, templateUpdateSchema, type TemplateDTO } from '@socialplan/shared';
import { all, first, newId, nowIso, run } from '../lib/db';
import { badRequest, conflict, notFound } from '../lib/errors';
import { audit } from '../lib/audit';
import { v } from '../lib/validate';
import type { AppEnv } from '../types';

type TemplateRow = TemplateDTO & { created_at: string };
const toDTO = (r: TemplateRow): TemplateDTO => ({
  id: r.id,
  brand_id: r.brand_id,
  kind: r.kind,
  name: r.name,
  platform: r.platform,
  body: r.body,
  updated_at: r.updated_at,
});

export const templateRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const brandId = c.req.query('brand_id');
    if (!brandId) throw badRequest('brand_id gerekli');
    const rows = await all<TemplateRow>(
      c.env.DB,
      'SELECT * FROM caption_templates WHERE brand_id = ? ORDER BY kind, name',
      brandId,
    );
    return c.json<TemplateDTO[]>(rows.map(toDTO));
  })
  .post('/', v('json', templateCreateSchema), async (c) => {
    const b = c.req.valid('json');
    if (!(await first(c.env.DB, 'SELECT id FROM brands WHERE id = ?', b.brand_id)))
      throw notFound('Marka');
    const id = newId();
    const at = nowIso();
    try {
      await run(
        c.env.DB,
        'INSERT INTO caption_templates (id, brand_id, kind, name, platform, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        b.brand_id,
        b.kind,
        b.name,
        b.platform ?? null,
        b.body,
        at,
        at,
      );
    } catch {
      throw conflict('Bu adla şablon zaten var', 'template_exists');
    }
    await audit(c.env.DB, c.get('actor'), 'template.create', 'template', id, {
      kind: b.kind,
      name: b.name,
    });
    return c.json<TemplateDTO>(
      toDTO(
        (await first<TemplateRow>(
          c.env.DB,
          'SELECT * FROM caption_templates WHERE id = ?',
          id,
        )) as TemplateRow,
      ),
      201,
    );
  })
  .patch('/:id', v('json', templateUpdateSchema), async (c) => {
    const id = c.req.param('id');
    const b = c.req.valid('json');
    const cur = await first<TemplateRow>(
      c.env.DB,
      'SELECT * FROM caption_templates WHERE id = ?',
      id,
    );
    if (!cur) throw notFound('Şablon');
    try {
      await run(
        c.env.DB,
        'UPDATE caption_templates SET name = ?, platform = ?, body = ?, updated_at = ? WHERE id = ?',
        b.name ?? cur.name,
        b.platform === undefined ? cur.platform : b.platform,
        b.body ?? cur.body,
        nowIso(),
        id,
      );
    } catch {
      throw conflict('Bu adla şablon zaten var', 'template_exists');
    }
    return c.json<TemplateDTO>(
      toDTO(
        (await first<TemplateRow>(
          c.env.DB,
          'SELECT * FROM caption_templates WHERE id = ?',
          id,
        )) as TemplateRow,
      ),
    );
  })
  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    if (!(await run(c.env.DB, 'DELETE FROM caption_templates WHERE id = ?', id)))
      throw notFound('Şablon');
    await audit(c.env.DB, c.get('actor'), 'template.delete', 'template', id);
    return c.json({ ok: true });
  });
