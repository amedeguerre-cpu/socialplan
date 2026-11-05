import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { BrandDTO, VideoDTO } from '@socialplan/shared';
import { api } from './helpers';
import { createBrand, goodMeta, uploadVideo } from './fixtures';

describe('markalar', () => {
  it('oluştur, listele, güncelle', async () => {
    const b = await createBrand('Kahve Dükkanı');
    const list = (await (await api('/api/brands')).json()) as BrandDTO[];
    expect(list.some((x) => x.id === b.id)).toBe(true);
    const res = await api(`/api/brands/${b.id}`, {
      method: 'PATCH',
      json: { paused: true, timezone: 'Europe/Berlin' },
    });
    const upd = (await res.json()) as BrandDTO;
    expect(upd.paused).toBe(true);
    expect(upd.timezone).toBe('Europe/Berlin');
  });
  it('aynı slug 409', async () => {
    await api('/api/brands', { method: 'POST', json: { name: 'X', slug: 'ayni-slug' } });
    const r = await api('/api/brands', { method: 'POST', json: { name: 'Y', slug: 'ayni-slug' } });
    expect(r.status).toBe(409);
  });
  it('geçersiz veri 400 ve Türkçe mesaj', async () => {
    const r = await api('/api/brands', { method: 'POST', json: { name: '' } });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { message: string }).message).toMatch(/Geçersiz veri/);
  });
});

describe('yükleme ve kuyruk', () => {
  it('10 video yüklenir, kuyrukta sıralanır ve yeniden sıralanabilir', async () => {
    const b = await createBrand();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await uploadVideo(b.id, { name: `video-${i}.mp4` })).id);
    const q = (await (await api(`/api/videos?brand_id=${b.id}&status=queue`)).json()) as VideoDTO[];
    expect(q.map((v) => v.id)).toEqual(ids);
    expect(q.every((v) => v.status === 'ready' && v.thumbnail_url)).toBe(true);
    // sonuncuyu başa taşı
    const r = await api(`/api/videos/${ids[9]}/reorder`, {
      method: 'POST',
      json: { before_id: null, after_id: ids[0] },
    });
    expect(r.status).toBe(200);
    // 3. videoyu 5 ile 6 arasına taşı
    await api(`/api/videos/${ids[2]}/reorder`, {
      method: 'POST',
      json: { before_id: ids[5], after_id: ids[6] },
    });
    const q2 = (await (
      await api(`/api/videos?brand_id=${b.id}&status=queue`)
    ).json()) as VideoDTO[];
    expect(q2.map((v) => v.id)).toEqual([
      ids[9],
      ids[0],
      ids[1],
      ids[3],
      ids[4],
      ids[5],
      ids[2],
      ids[6],
      ids[7],
      ids[8],
    ]);
    const brand = (await (await api(`/api/brands/${b.id}`)).json()) as BrandDTO;
    expect(brand.queue_count).toBe(10);
  });

  it('çok parçalı (16 MiB+) yükleme R2 nesnesini doğru birleştirir', async () => {
    const b = await createBrand();
    const bytes = new Uint8Array(16 * 1024 * 1024 + 4096);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;
    const vdto = await uploadVideo(b.id, { bytes });
    const row = await env.DB.prepare('SELECT r2_key, size_bytes FROM videos WHERE id = ?')
      .bind(vdto.id)
      .first<{ r2_key: string; size_bytes: number }>();
    const obj = await env.MEDIA.get(row?.r2_key ?? '');
    expect(obj?.size).toBe(bytes.length);
    expect(row?.size_bytes).toBe(bytes.length);
    // Range ile önizleme
    const rr = await api(`/api/media/video/${vdto.id}`, { headers: { range: 'bytes=0-9' } });
    expect(rr.status).toBe(206);
    expect(rr.headers.get('content-range')).toBe(`bytes 0-9/${bytes.length}`);
    expect((await rr.arrayBuffer()).byteLength).toBe(10);
  });

  it('hiçbir platforma uymayan video invalid olur ve platform bazında neden verir', async () => {
    const b = await createBrand();
    const vdto = await uploadVideo(b.id, {
      meta: { width: 1920, height: 1080, durationMs: 1_200_000, fps: 15 },
    });
    expect(vdto.status).toBe('invalid');
    expect(vdto.validation?.instagram.ok).toBe(false);
    expect(vdto.validation?.youtube.issues.map((i) => i.code)).toContain('vertical');
  });

  it('ai_generated seçimi zorunlu', async () => {
    const b = await createBrand();
    const init = await api('/api/uploads', {
      method: 'POST',
      json: { brand_id: b.id, original_name: 'a.mp4', mime: 'video/mp4', size_bytes: 10 },
    });
    const j = (await init.json()) as { video_id: string };
    const r = await api(`/api/uploads/${j.video_id}/complete`, {
      method: 'POST',
      json: { parts: [{ partNumber: 1, etag: 'x' }], meta: goodMeta(10) },
    });
    expect(r.status).toBe(400);
  });

  it('yerel parça imzası olmadan 403', async () => {
    const b = await createBrand();
    const init = await api('/api/uploads', {
      method: 'POST',
      json: { brand_id: b.id, original_name: 'a.mp4', mime: 'video/mp4', size_bytes: 10 },
    });
    const j = (await init.json()) as { video_id: string };
    const r = await api(`/api/uploads/local/${j.video_id}/parts/1?exp=9999999999&t=sahte`, {
      method: 'PUT',
      body: new Uint8Array(10),
    });
    expect(r.status).toBe(403);
  });

  it('aynı içerik başka markada uyarı verir', async () => {
    const a = await createBrand('A Markası');
    const b = await createBrand('B Markası');
    await uploadVideo(a.id, { hash: 'abcdef0123456789' });
    const v2 = await uploadVideo(b.id, { hash: 'abcdef0123456789' });
    expect(v2.duplicate_warning).toMatch(/A Markası/);
  });

  it('caption override ve hashtag güncelleme', async () => {
    const b = await createBrand();
    const vdto = await uploadVideo(b.id);
    const r = await api(`/api/videos/${vdto.id}`, {
      method: 'PATCH',
      json: {
        description: 'Yeni',
        hashtags: ['#kahve', 'sabah'],
        caption_overrides: { tiktok: 'TT metni' },
      },
    });
    const u = (await r.json()) as VideoDTO;
    expect(u.hashtags).toEqual(['kahve', 'sabah']);
    expect(u.caption_overrides).toEqual({ tiktok: 'TT metni' });
  });

  it('video silinince R2 nesnesi silinir, kuyruktan çıkar', async () => {
    const b = await createBrand();
    const vdto = await uploadVideo(b.id);
    expect((await api(`/api/videos/${vdto.id}`, { method: 'DELETE' })).status).toBe(200);
    const q = (await (await api(`/api/videos?brand_id=${b.id}&status=queue`)).json()) as VideoDTO[];
    expect(q).toHaveLength(0);
  });
});
