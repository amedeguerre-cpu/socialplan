import { describe, expect, it } from 'vitest';
import { buildCaption, parseHashtagSet, renderTemplate, withSignature } from '../src';

describe('metin şablonları', () => {
  it('değişkenleri doldurur, bilinmeyeni bırakır, boş satırları sıkıştırır', () => {
    const t = '{baslik} 🎬\n\n{aciklama}\n\n\n{hashtagler}\n{bilinmeyen}';
    expect(renderTemplate(t, { baslik: 'Kahve', aciklama: '', hashtagler: '#kahve #sabah' })).toBe(
      'Kahve 🎬\n\n#kahve #sabah\n{bilinmeyen}',
    );
    expect(renderTemplate('{MARKA} — {tarih}', { marka: 'Kafe', tarih: '05.11.2026' })).toBe(
      'Kafe — 05.11.2026',
    );
  });
  it('hashtag seti: # olmadan, tekrarsız, geçersizler atlanır', () => {
    expect(parseHashtagSet('#kahve, #sabah kahve  #kötü-etiket #çay')).toEqual([
      'kahve',
      'sabah',
      'çay',
    ]);
  });
  it('marka imzası bir kez ve en sona eklenir', () => {
    expect(withSignature('Metin', '🛒 kafe.com')).toBe('Metin\n\n🛒 kafe.com');
    expect(withSignature('Metin\n\n🛒 kafe.com', '🛒 kafe.com')).toBe('Metin\n\n🛒 kafe.com');
    expect(withSignature('Metin', '  ')).toBe('Metin');
    const src = {
      title: 'B',
      description: 'Açıklama',
      hashtags: ['a'],
      caption_overrides: { tiktok: 'TT' },
    };
    expect(buildCaption(src, 'instagram', { signature: 'imza' })).toBe('Açıklama\n\n#a\n\nimza');
    expect(buildCaption(src, 'tiktok', { signature: 'imza' })).toBe('TT\n\nimza');
  });
});
