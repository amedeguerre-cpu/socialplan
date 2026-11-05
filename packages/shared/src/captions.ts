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
export function buildCaption(
  src: CaptionSource,
  platform: Platform,
  opts: { signature?: string } = {},
): string {
  const override = src.caption_overrides[platform];
  const tags = src.hashtags.map(normalizeHashtag).filter(Boolean).join(' ');
  const body = src.description.trim() || src.title.trim();
  const base =
    override !== undefined && override.trim() !== ''
      ? override
      : [body, tags].filter(Boolean).join('\n\n');
  return withSignature(base, opts.signature);
}

/** Marka imzasını (ör. "🛒 site.com") metnin sonuna bir kez ekler. */
export function withSignature(text: string, signature?: string): string {
  const sig = (signature ?? '').trim();
  if (!sig || text.includes(sig)) return text;
  return text.trim() ? `${text.trimEnd()}\n\n${sig}` : sig;
}

export interface TemplateVars {
  baslik?: string;
  aciklama?: string;
  marka?: string;
  tarih?: string;
  hashtagler?: string;
  platform?: string;
}

export const TEMPLATE_VARS: (keyof TemplateVars)[] = [
  'baslik',
  'aciklama',
  'marka',
  'tarih',
  'hashtagler',
  'platform',
];

/**
 * Şablon değişkenleri: {baslik} {aciklama} {marka} {tarih} {hashtagler} {platform}.
 * Bilinmeyen değişken olduğu gibi bırakılır; değeri boş olan değişkenin bıraktığı fazla boş satırlar sıkıştırılır.
 */
export function renderTemplate(body: string, vars: TemplateVars): string {
  const out = body.replace(/\{([a-zçğıöşü_]+)\}/gi, (m, k: string) => {
    const key = k.toLocaleLowerCase('tr') as keyof TemplateVars;
    return TEMPLATE_VARS.includes(key) ? (vars[key] ?? '') : m;
  });
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Hashtag seti metnini ("#a #b, c") etiket listesine çevirir (tekrarsız, # olmadan). */
export function parseHashtagSet(body: string): string[] {
  const seen = new Set<string>();
  for (const raw of body.split(/[\s,]+/)) {
    const t = raw.trim().replace(/^#+/, '');
    if (t && /^[\p{L}\p{N}_]{1,100}$/u.test(t)) seen.add(t);
  }
  return [...seen];
}

/** YouTube başlığı ≤ 100 karakter; boşsa caption'ın ilk satırı. */
export function youtubeTitle(src: CaptionSource): string {
  const raw = (src.title.trim() || src.description.split('\n')[0] || 'Video').replace(/[<>]/g, '');
  const withShorts = raw.includes('#Shorts') || raw.length > 90 ? raw : `${raw} #Shorts`;
  return withShorts.slice(0, 100);
}
