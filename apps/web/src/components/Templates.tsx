import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  PLATFORMS,
  PLATFORM_LABELS,
  TEMPLATE_VARS,
  type Platform,
  type TemplateDTO,
} from '@socialplan/shared';
import { api } from '../lib/api';
import { useInvalidate } from '../lib/hooks';
import { Button, Field, inputCls } from './ui';

export const useTemplates = (brandId: string | null) =>
  useQuery({
    queryKey: ['templates', brandId],
    queryFn: () => api.get<TemplateDTO[]>(`/templates?brand_id=${brandId}`),
    enabled: !!brandId,
  });

/** Ayarlar: marka için metin şablonları ve hashtag setleri. */
export function TemplateManager({ brandId }: { brandId: string }) {
  const q = useTemplates(brandId);
  const inv = useInvalidate();
  const [kind, setKind] = useState<'caption' | 'hashtags'>('caption');
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<'' | Platform>('');
  const [body, setBody] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    setErr(null);
    try {
      await api.post('/templates', {
        brand_id: brandId,
        kind,
        name,
        platform: platform || null,
        body,
      });
      setName('');
      setBody('');
      await inv(['templates', brandId]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Eklenemedi');
    }
  };
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[140px_1fr_140px]">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as 'caption' | 'hashtags')}
          className={inputCls}
          aria-label="Tür"
        >
          <option value="caption">Metin şablonu</option>
          <option value="hashtags">Hashtag seti</option>
        </select>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ad (ör. Ürün tanıtımı)"
          className={inputCls}
        />
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value as '' | Platform)}
          className={inputCls}
          aria-label="Platform"
        >
          <option value="">Tüm platformlar</option>
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {PLATFORM_LABELS[p]}
            </option>
          ))}
        </select>
      </div>
      <Field
        label={kind === 'caption' ? 'Metin' : 'Etiketler'}
        hint={
          kind === 'caption'
            ? `Değişkenler: ${TEMPLATE_VARS.map((v) => `{${v}}`).join(' ')}`
            : 'Boşluk veya virgülle: #kahve #sabah'
        }
      >
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          className={inputCls}
        />
      </Field>
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          disabled={!name.trim() || !body.trim()}
          onClick={() => void add()}
        >
          Ekle
        </Button>
        {err && <span className="text-sm text-red-600">{err}</span>}
      </div>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {(q.data ?? []).length === 0 && (
          <li className="px-3 py-2 text-sm text-slate-500">Henüz şablon yok.</li>
        )}
        {(q.data ?? []).map((t) => (
          <li key={t.id} className="flex items-start gap-2 px-3 py-2 text-sm">
            <span className="w-28 shrink-0 text-xs text-slate-500">
              {t.kind === 'caption' ? 'Metin' : 'Hashtag'}
              {t.platform ? ` · ${PLATFORM_LABELS[t.platform]}` : ''}
            </span>
            <span className="w-40 shrink-0 font-medium">{t.name}</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap text-slate-600">{t.body}</span>
            <button
              className="text-slate-400 hover:text-red-600"
              title="Sil"
              onClick={() =>
                confirm('Şablon silinsin mi?') &&
                void api.del(`/templates/${t.id}`).then(() => inv(['templates', brandId]))
              }
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
