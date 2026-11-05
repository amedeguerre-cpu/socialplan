import { Hono } from 'hono';
import { assertSafeConfig, ConfigError } from './env';
import { accessMiddleware, originMiddleware } from './auth/access';
import { createLogger } from './lib/log';
import { errorResponse } from './lib/errors';
import { systemRoutes } from './routes/system';
import type { AppEnv } from './types';

const api = new Hono<AppEnv>()
  .use('*', accessMiddleware)
  .use('*', originMiddleware)
  .route('/', systemRoutes);

export const app = new Hono<AppEnv>()
  .use('*', async (c, next) => {
    try {
      assertSafeConfig(c.env);
    } catch (e) {
      if (e instanceof ConfigError)
        return c.json({ error: 'misconfigured', message: e.message }, 500);
      throw e;
    }
    c.set('log', createLogger({ path: new URL(c.req.url).pathname }));
    await next();
  })
  .route('/api', api)
  .all('/api/*', (c) => c.json({ error: 'not_found', message: 'Uç bulunamadı' }, 404))
  .all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((e, c) => errorResponse(c, e));

export type ApiType = typeof api;
