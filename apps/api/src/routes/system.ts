import { Hono } from 'hono';
import { v } from '../lib/validate';
import {
  settingsUpdateSchema,
  type AuditDTO,
  type MeDTO,
  type Paged,
  type SettingsDTO,
} from '@socialplan/shared';
import { all, first, parseJson } from '../lib/db';
import { notify, sendChannels } from '../notify';
import { decryptJson, encryptJson, parseKeySpec } from '../lib/crypto';
import { createHttp } from '../publish/http';
import { runDaily } from '../scheduler/daily';
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
  .put('/settings', v('json', settingsUpdateSchema), async (c) => {
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
      await notify(
        c.env,
        {
          kind: 'kill_switch',
          dedupeKey: `kill_switch:${patch.kill_switch ? 'on' : 'off'}:${new Date().toISOString()}`,
          title: patch.kill_switch ? 'Kill switch AÇILDI' : 'Kill switch kapatıldı',
          text: `${c.get('actor')} tarafından. ${patch.kill_switch ? 'Yeni paylaşım başlamaz.' : 'Paylaşımlar devam eder.'}`,
        },
        c.get('log'),
      );
    }
    return c.json({ ok: true });
  })
  .get('/audit', async (c) => {
    const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
    const size = 50;
    const total = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM audit_log');
    const rows = await all<{
      id: string;
      at: string;
      actor_email: string;
      action: string;
      entity_type: string | null;
      entity_id: string | null;
      detail: string | null;
    }>(
      c.env.DB,
      'SELECT * FROM audit_log ORDER BY at DESC LIMIT ? OFFSET ?',
      size,
      (page - 1) * size,
    );
    return c.json<Paged<AuditDTO>>({
      items: rows.map((r) => ({ ...r, detail: parseJson(r.detail, null) })),
      total: total?.n ?? 0,
      page,
      page_size: size,
    });
  })
  .post('/notify/test', async (c) => {
    const s = await getSettings(c.env.DB);
    const r = await sendChannels(
      c.env,
      createHttp(c.env, c.get('log')),
      {
        kind: 'test',
        dedupeKey: 'test',
        title: 'SocialPlan deneme mesajı',
        text: `${c.get('actor')} bildirim ayarlarını denedi.`,
      },
      s.notify,
    );
    await audit(c.env.DB, c.get('actor'), 'notify.test', 'settings', 'notify', r);
    return c.json(r);
  })
  /** Anahtar döndürme: tüm hesap token'larını güncel TOKEN_ENC_KEY ile yeniden şifreler (çözmede _PREV de denenir). */
  .post('/system/rotate-tokens', async (c) => {
    const { version } = parseKeySpec(c.env.TOKEN_ENC_KEY);
    const rows = await all<{ id: string; secret_blob: string; secret_key_version: number }>(
      c.env.DB,
      'SELECT id, secret_blob, secret_key_version FROM accounts WHERE secret_blob IS NOT NULL',
    );
    let rotated = 0;
    let skipped = 0;
    const failed: string[] = [];
    for (const r of rows) {
      if (r.secret_key_version === version && r.secret_blob.startsWith(`v${version}.`)) continue;
      try {
        const plain = await decryptJson<unknown>(c.env, r.secret_blob);
        const enc = await encryptJson(c.env, plain);
        // Okunan blob hâlâ aynıysa yaz: arada token yenilendiyse (saveTokens zaten güncel anahtarla yazar) ezme.
        const res = await c.env.DB.prepare(
          'UPDATE accounts SET secret_blob = ?, secret_key_version = ? WHERE id = ? AND secret_blob = ?',
        )
          .bind(enc.blob, enc.version, r.id, r.secret_blob)
          .run();
        if (res.meta.changes === 1) rotated++;
        else skipped++;
      } catch {
        failed.push(r.id);
      }
    }
    await audit(c.env.DB, c.get('actor'), 'system.rotate_tokens', null, null, {
      rotated,
      failed: failed.length,
      version,
    });
    return c.json({ rotated, skipped, failed, version, total: rows.length });
  })
  .post('/system/run-daily', async (c) => {
    const r = await runDaily(c.env, new Date(), c.get('log'));
    await audit(c.env.DB, c.get('actor'), 'system.run_daily', null, null, r);
    return c.json(r);
  });
