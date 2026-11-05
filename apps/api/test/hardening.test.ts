import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, testEnv } from './helpers';
import { createBrand, insertAccount } from './fixtures';
import { mockServer, json } from './mockServer';
import { decryptJson, encryptJson } from '../src/lib/crypto';
import { notify } from '../src/notify';
import { mask, maskString } from '../src/lib/log';
import { createHttp, DryRunBlockedError } from '../src/publish/http';
import { createLogger } from '../src/lib/log';
import type { Env } from '../src/env';

const KEY2 = '2:' + btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

describe('token şifreleme ve anahtar döndürme', () => {
  it('her kayıtta farklı IV; yanlış anahtarla çözülemez', async () => {
    const e = env as unknown as Env;
    const a = await encryptJson(e, { access_token: 'x' });
    const b = await encryptJson(e, { access_token: 'x' });
    expect(a.blob).not.toBe(b.blob);
    expect(await decryptJson(e, a.blob)).toEqual({ access_token: 'x' });
    await expect(decryptJson({ ...e, TOKEN_ENC_KEY: KEY2 }, a.blob)).rejects.toThrow();
  });

  it('yeni anahtar + _PREV ile token’lar yeniden şifrelenir', async () => {
    const b = await createBrand();
    const id = await insertAccount(b.id, 'instagram', {
      tokens: { access_token: 'ESKI-ANAHTAR-TOKEN' },
    });
    const r = await api(
      '/api/system/rotate-tokens',
      { method: 'POST' },
      { TOKEN_ENC_KEY: KEY2, TOKEN_ENC_KEY_PREV: (env as unknown as Env).TOKEN_ENC_KEY },
    );
    const j = (await r.json()) as { rotated: number; version: number };
    expect(j.version).toBe(2);
    expect(j.rotated).toBeGreaterThanOrEqual(1);
    const row = await env.DB.prepare(
      'SELECT secret_blob, secret_key_version FROM accounts WHERE id = ?',
    )
      .bind(id)
      .first<{ secret_blob: string; secret_key_version: number }>();
    expect(row?.secret_key_version).toBe(2);
    expect(
      await decryptJson({ ...(env as unknown as Env), TOKEN_ENC_KEY: KEY2 }, row!.secret_blob),
    ).toEqual({ access_token: 'ESKI-ANAHTAR-TOKEN' });
    // diğer testleri etkilemesin
    await env.DB.prepare(
      "UPDATE accounts SET status = 'disabled', secret_blob = NULL WHERE secret_key_version = 2",
    ).run();
  });
});

describe('log maskesi', () => {
  it('Authorization, access_token, refresh_token, code, client_secret maskelenir', () => {
    expect(maskString('https://x/y?access_token=ABC&code=KOD&a=1')).toBe(
      'https://x/y?access_token=***&code=***&a=1',
    );
    expect(maskString('Bearer eyJhbGciOi.payload.sig')).toBe('Bearer ***');
    expect(
      mask({
        authorization: 'Bearer x',
        refresh_token: 'r',
        client_secret: 's',
        nested: { code: 'c', ok: 'görünür' },
      }),
    ).toEqual({
      authorization: '***',
      refresh_token: '***',
      client_secret: '***',
      nested: { code: '***', ok: 'görünür' },
    });
  });
});

describe('DRY_RUN', () => {
  it('platform alanlarına giden her istek reddedilir; bildirim kanalları serbest', async () => {
    const m = mockServer({ 'POST hooks\\.slack\\.com/.*': () => json({ ok: true }) });
    const http = createHttp(testEnv({ DRY_RUN: 'true' }), createLogger());
    for (const u of [
      'https://graph.instagram.com/v26.0/me',
      'https://open.tiktokapis.com/v2/x',
      'https://www.googleapis.com/upload/youtube/v3/videos',
      'https://oauth2.googleapis.com/token',
      'https://rupload.facebook.com/x',
    ]) {
      await expect(http.fetch(u, { method: 'POST' }, { purpose: 't' })).rejects.toBeInstanceOf(
        DryRunBlockedError,
      );
    }
    await http.fetch(
      'https://hooks.slack.com/services/T/B/X',
      { method: 'POST' },
      { purpose: 'notify' },
    );
    expect(m.calls.map((c) => c.url.host)).toEqual(['hooks.slack.com']);
  });
});

describe('bildirimler', () => {
  it('dedupe_key ile tek gönderim; Slack + Telegram; mesajda sır yok', async () => {
    const m = mockServer({
      'POST hooks\\.slack\\.com/.*': () => json({ ok: true }),
      'POST api\\.telegram\\.org/.*': () => json({ ok: true }),
    });
    await env.DB.prepare(
      'UPDATE settings SET value = \'{"slack":true,"telegram":true}\' WHERE key = \'notify\'',
    ).run();
    const e = testEnv({
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X',
      TELEGRAM_BOT_TOKEN: '123:ABC',
      TELEGRAM_CHAT_ID: '-100',
    });
    try {
      const key = `test:${crypto.randomUUID()}`;
      expect(
        await notify(e, {
          kind: 'publish_failed',
          dedupeKey: key,
          title: 'Hata',
          text: 'istek https://x/?access_token=GIZLI başarısız',
        }),
      ).toBe(true);
      expect(
        await notify(e, { kind: 'publish_failed', dedupeKey: key, title: 'Hata', text: 'tekrar' }),
      ).toBe(false);
      expect(m.calls).toHaveLength(2);
      for (const c of m.calls) expect(c.body).not.toContain('GIZLI');
      expect(m.calls[1]?.url.pathname).toBe('/bot123:ABC/sendMessage');
    } finally {
      await env.DB.prepare(
        'UPDATE settings SET value = \'{"slack":false,"telegram":false}\' WHERE key = \'notify\'',
      ).run();
    }
  });

  it('kill switch açılınca audit ve bildirim kaydı oluşur', async () => {
    await api('/api/settings', { method: 'PUT', json: { kill_switch: true } });
    await api('/api/settings', { method: 'PUT', json: { kill_switch: false } });
    const a = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('kill_switch.on','kill_switch.off')",
    ).first<{ n: number }>();
    expect(a?.n).toBeGreaterThanOrEqual(2);
    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE kind = 'kill_switch'",
    ).first<{ n: number }>();
    expect(n?.n).toBeGreaterThanOrEqual(2);
    const audit = (await (await api('/api/audit')).json()) as { items: { action: string }[] };
    expect(audit.items.some((i) => i.action === 'kill_switch.on')).toBe(true);
  });
});
