import type { Platform } from './platforms';

export interface CaptionSource {
  title: string;
  description: string;
  hashtags: string[];
  caption_overrides: Partial<Record<Platform, string>>;
}

export function normalizeHashtag(tag: string): string {
  const t = tag.trim().replace(/^#+/, '');
  return t ? `#${t}` : '';
}

/** Platform caption'ı: override varsa o, yoksa açıklama + hashtag'ler. */
export function buildCaption(src: CaptionSource, platform: Platform): string {
  const override = src.caption_overrides[platform];
  if (override !== undefined && override.trim() !== '') return override;
  const tags = src.hashtags.map(normalizeHashtag).filter(Boolean).join(' ');
  const body = src.description.trim() || src.title.trim();
  return [body, tags].filter(Boolean).join('\n\n');
}

/** YouTube başlığı ≤ 100 karakter; boşsa caption'ın ilk satırı. */
export function youtubeTitle(src: CaptionSource): string {
  const raw = (src.title.trim() || src.description.split('\n')[0] || 'Video').replace(/[<>]/g, '');
  const withShorts = raw.includes('#Shorts') || raw.length > 90 ? raw : `${raw} #Shorts`;
  return withShorts.slice(0, 100);
}
