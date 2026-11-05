import { app } from './app';
import { assertSafeConfig, type Env, type PublishMessage } from './env';
import { handleScheduled } from './scheduler/cron';
import { handleQueue } from './publish/consumer';

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    assertSafeConfig(env);
    ctx.waitUntil(handleScheduled(env, new Date(controller.scheduledTime), controller.cron));
  },
  async queue(batch, env) {
    assertSafeConfig(env);
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<Env, PublishMessage>;

export type { ApiType } from './app';
