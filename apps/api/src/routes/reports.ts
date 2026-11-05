import { Hono } from 'hono';
import { z } from 'zod';
import type { WeeklyReportDTO } from '@socialplan/shared';
import { first } from '../lib/db';
import { notFound } from '../lib/errors';
import { audit } from '../lib/audit';
import { v } from '../lib/validate';
import type { BrandRow } from '../lib/rows';
import { buildWeeklyReport } from '../lib/weekly';
import { sendWeeklyReports } from '../scheduler/weekly';
import type { AppEnv } from '../types';

export const reportRoutes = new Hono<AppEnv>()
  .get('/weekly', v('query', z.object({ brand_id: z.string().min(1) })), async (c) => {
    const b = await first<BrandRow>(
      c.env.DB,
      'SELECT * FROM brands WHERE id = ?',
      c.req.valid('query').brand_id,
    );
    if (!b) throw notFound('Marka');
    return c.json<WeeklyReportDTO>(
      await buildWeeklyReport(c.env.DB, b, new Date(), c.env.APP_BASE_URL),
    );
  })
  .post(
    '/weekly/send',
    v('json', z.object({ brand_id: z.string().min(1).optional() })),
    async (c) => {
      const { brand_id } = c.req.valid('json');
      const sent = await sendWeeklyReports(c.env, new Date(), c.get('log'), {
        brandId: brand_id,
        force: true,
      });
      await audit(c.env.DB, c.get('actor'), 'report.weekly_send', 'brand', brand_id ?? null, {
        sent,
      });
      return c.json({ sent });
    },
  );
