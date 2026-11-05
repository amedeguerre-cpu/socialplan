import { describe, expect, it } from 'vitest';
import { api } from './helpers';
import { createBrand, insertAccount, uploadVideo } from './fixtures';

const FORBIDDEN = [
  'secret_blob',
  'access_token',
  'refresh_token',
  'AT-gizli',
  'RT-gizli',
  'client_secret',
  'secret_key_version',
];

describe('DTO’larda sır yok', () => {
  it('hesap, marka, video, post ve ayar yanıtları token içermez', async () => {
    const b = await createBrand();
    await insertAccount(b.id, 'instagram');
    await insertAccount(b.id, 'youtube');
    const v = await uploadVideo(b.id);
    await api('/api/posts/manual', {
      method: 'POST',
      json: { video_id: v.id, platforms: ['instagram'], date: '2030-02-01', time: '10:00' },
    });
    const bodies = await Promise.all(
      [
        '/api/accounts',
        `/api/accounts?brand_id=${b.id}`,
        '/api/brands',
        `/api/videos?brand_id=${b.id}`,
        `/api/posts?brand_id=${b.id}`,
        '/api/settings',
        '/api/accounts/quota',
      ].map(async (p) => {
        const r = await api(p);
        expect(r.status).toBe(200);
        return r.text();
      }),
    );
    for (const body of bodies) for (const f of FORBIDDEN) expect(body).not.toContain(f);
    const accounts = JSON.parse(bodies[1] ?? '[]') as Record<string, unknown>[];
    expect(accounts).toHaveLength(2);
    expect(Object.keys(accounts[0] ?? {})).not.toContain('secret_blob');
  });
});
