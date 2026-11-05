import { describe, expect, it } from 'vitest';
import { generateKeyPair } from 'jose';
import { api, BASE, installJwks, rawFetch, signAccessJwt } from './helpers';

describe('Cloudflare Access', () => {
  it('başlıksız istek 401', async () => {
    await installJwks();
    const res = await rawFetch(new Request(`${BASE}/api/me`));
    expect(res.status).toBe(401);
  });

  it('geçerli JWT ile 200 ve e-posta döner', async () => {
    const res = await api('/api/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'ekip@example.com', dev_bypass: false });
  });

  it('geçersiz imza 401', async () => {
    const other = await generateKeyPair('RS256');
    const token = await signAccessJwt({ key: other.privateKey });
    const res = await api('/api/me', { headers: { 'cf-access-jwt-assertion': token } });
    expect(res.status).toBe(401);
  });

  it('yanlış aud 401', async () => {
    const token = await signAccessJwt({ aud: 'baska-uygulama' });
    expect((await api('/api/me', { headers: { 'cf-access-jwt-assertion': token } })).status).toBe(
      401,
    );
  });

  it('yanlış iss 401', async () => {
    const token = await signAccessJwt({ iss: 'https://kotu.cloudflareaccess.com' });
    expect((await api('/api/me', { headers: { 'cf-access-jwt-assertion': token } })).status).toBe(
      401,
    );
  });

  it('süresi dolmuş JWT 401', async () => {
    const token = await signAccessJwt({ expSec: -60 });
    expect((await api('/api/me', { headers: { 'cf-access-jwt-assertion': token } })).status).toBe(
      401,
    );
  });

  it('ACCESS_DEV_BYPASS production adresinde Worker açılmaz', async () => {
    const res = await api('/api/me', {}, { ACCESS_DEV_BYPASS: 'dev@local' });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('misconfigured');
  });

  it('ACCESS_DEV_BYPASS yalnız localhost isteğinde geçerli', async () => {
    const res = await rawFetch(new Request('http://localhost:8787/api/me'), {
      ACCESS_DEV_BYPASS: 'dev@local',
      APP_BASE_URL: 'http://localhost:8787',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dev_bypass: boolean }).dev_bypass).toBe(true);
    const remote = await rawFetch(new Request('http://10.0.0.5:8787/api/me'), {
      ACCESS_DEV_BYPASS: 'dev@local',
      APP_BASE_URL: 'http://localhost:8787',
    });
    expect(remote.status).toBe(401);
  });

  it('durum değiştiren istekte yanlış Origin 403', async () => {
    const res = await api('/api/settings', {
      method: 'PUT',
      json: { retention_days: 10 },
      headers: { origin: 'https://kotu.example' },
    });
    expect(res.status).toBe(403);
  });

  it('bilinmeyen /api ucu 404 JSON', async () => {
    expect((await api('/api/yok')).status).toBe(404);
  });
});
