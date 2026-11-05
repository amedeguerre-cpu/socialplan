import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { settingsUpdateSchema, type MeDTO, type SettingsDTO } from '@socialplan/shared';
import { allowedAccountIds, isDryRun } from '../env';
import { getSettings, setSettings } from '../lib/settings';
import { audit } from '../lib/audit';
import type { AppEnv } from '../types';

export const systemRoutes = new Hono<AppEnv>()
  .get('/me', (c) => c.json<MeDTO>({ email: c.get('actor'), dev_bypass: c.get('devBypass') }))
  .get('/settings', async (c) => {
    const s = await getSettings(c.env.DB);
    return c.json<SettingsDTO>({
      ...s,
      notify_available: {
        slack: !!c.env.SLACK_WEBHOOK_URL,
        telegram: !!(c.env.TELEGRAM_BOT_TOKEN && c.env.TELEGRAM_CHAT_ID),
      },
      dry_run: isDryRun(c.env),
      allowed_account_ids: allowedAccountIds(c.env),
    });
  })
  .put('/settings', zValidator('json', settingsUpdateSchema), async (c) => {
    const patch = c.req.valid('json');
    const before = await getSettings(c.env.DB);
    await setSettings(c.env.DB, patch, c.get('actor'));
    await audit(c.env.DB, c.get('actor'), 'settings.update', 'settings', null, { patch });
    if (patch.kill_switch !== undefined && patch.kill_switch !== before.kill_switch) {
      await audit(
        c.env.DB,
        c.get('actor'),
        patch.kill_switch ? 'kill_switch.on' : 'kill_switch.off',
        'settings',
        'kill_switch',
      );
    }
    return c.json({ ok: true });
  });
